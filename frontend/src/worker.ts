interface AssetFetcher { fetch(request: Request): Promise<Response> }
interface Env { AWS_ACCESS_KEY_ID: string; AWS_SECRET_ACCESS_KEY: string; AWS_SESSION_TOKEN?: string; AWS_REGION: string; AWS_ZONE: string; ASSETS: AssetFetcher }
type AwsInstance = { InstanceId?: string; InstanceType?: string; InstanceLifecycle?: string; State?: { Name?: string }; Placement?: { AvailabilityZone?: string }; PrivateIpAddress?: string; PublicIpAddress?: string; Tags?: { Key?: string; Value?: string }[] }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
  try {
    if (!env.AWS_REGION || !env.AWS_ZONE) return json({ error: 'AWS_REGION and AWS_ZONE must be configured.' }, 500)
    if (request.method === 'GET' && url.pathname === '/api/instances') {
      const allInstances: AwsInstance[] = []
      let nextToken: string | undefined
      do {
        const result = await awsRequest('DescribeInstances', {
          Filter: [{ Name: 'availability-zone', Value: [env.AWS_ZONE] }],
          ...(nextToken ? { NextToken: nextToken } : {}),
        }, env)
        const reservations = (result.Reservation ?? []) as { Instances?: AwsInstance[] }[]
        allInstances.push(...reservations.flatMap((reservation) => reservation.Instances ?? []))
        nextToken = typeof result.NextToken === 'string' ? result.NextToken : undefined
      } while (nextToken)
      const instances = allInstances.filter((instance) => isAllowedInstance(instance, env)).map(toInstance).filter((instance): instance is NonNullable<ReturnType<typeof toInstance>> => Boolean(instance))
      return json({ region: env.AWS_REGION, zone: env.AWS_ZONE, instances })
    }
    const match = url.pathname.match(/^\/api\/instances\/([^/]+)\/(start|stop)$/)
    if (request.method === 'POST' && match) {
      const instanceId = decodeURIComponent(match[1])
      if (!/^i-[a-z0-9]+$/.test(instanceId)) return json({ error: 'Invalid instance ID.' }, 400)
      const check = await awsRequest('DescribeInstances', { InstanceId: [instanceId] }, env)
      const found = (check.Reservation ?? []) as { Instances?: AwsInstance[] }[]
      const instance = found.flatMap((reservation) => reservation.Instances ?? []).find((candidate) => candidate.InstanceId === instanceId)
      if (!instance) return json({ error: 'Instance not found in this region.' }, 404)
      if (!isAllowedInstance(instance, env)) return json({ error: 'This instance is outside the current filter.' }, 403)
      await awsRequest(match[2] === 'start' ? 'StartInstances' : 'StopInstances', { InstanceId: [instanceId] }, env)
      return json({ ok: true })
    }
    return json({ error: 'Not found.' }, 404)
  } catch (error) {
    console.error(JSON.stringify({ event: 'aws_request_failed', message: error instanceof Error ? error.message : 'unknown' }))
    return json({ error: error instanceof Error ? error.message : 'AWS request failed.' }, 502)
  }
} }

function toInstance(instance: AwsInstance) {
  if (!instance.InstanceId) return null
  return { id: instance.InstanceId, name: instance.Tags?.find((tag) => tag.Key === 'Name')?.Value ?? instance.InstanceId, type: instance.InstanceType ?? 'EC2', state: instance.State?.Name ?? 'unknown', lifecycle: instance.InstanceLifecycle, zone: instance.Placement?.AvailabilityZone, privateIp: instance.PrivateIpAddress, publicIp: instance.PublicIpAddress }
}
function isAllowedInstance(instance: AwsInstance, env: Env) { const discovered = toInstance(instance); return Boolean(discovered && discovered.zone === env.AWS_ZONE && discovered.name.toLowerCase().includes('arqui')) }

async function awsRequest(action: string, params: Record<string, unknown>, env: Env): Promise<Record<string, unknown>> { const host = `ec2.${env.AWS_REGION}.amazonaws.com`, body = new URLSearchParams({ Action: action, Version: '2016-11-15', ...flatten(params) }).toString(), headers = await signedHeaders('POST', host, body, env), response = await fetch(`https://${host}/`, { method: 'POST', headers, body }), text = await response.text(); if (!response.ok || text.includes('<Error>')) throw new Error(parseAwsError(text)); return parseAwsResponse(text) }
function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> { const output: Record<string, string> = {}; for (const [key, child] of Object.entries(value)) { const name = prefix ? `${prefix}.${key}` : key; if (Array.isArray(child)) child.forEach((item, index) => typeof item === 'object' && item ? Object.assign(output, flatten(item as Record<string, unknown>, `${name}.${index + 1}`)) : output[`${name}.${index + 1}`] = String(item)); else if (typeof child === 'object' && child) Object.assign(output, flatten(child as Record<string, unknown>, name)); else output[name] = String(child) } return output }
function parseAwsResponse(xml: string) {
  const matches = [...xml.matchAll(/<instanceId>([\s\S]*?)<\/instanceId>/g)]
  const instances = matches.map((match, index) => parseInstance(xml.slice(match.index, matches[index + 1]?.index ?? xml.length)))
  return { NextToken: xmlValue(xml, 'nextToken'), Reservation: [{ Instances: instances }] }
}
function parseInstance(xml: string): AwsInstance {
  const tags = [...xml.matchAll(/<tagSet>([\s\S]*?)<\/tagSet>/g)].flatMap((tagSet) => [...(tagSet[1] ?? '').matchAll(/<item>[\s\S]*?<key>([\s\S]*?)<\/key>[\s\S]*?<value>([\s\S]*?)<\/value>[\s\S]*?<\/item>/g)].map((tag) => ({ Key: decodeXml(tag[1]), Value: decodeXml(tag[2]) })))
  return { InstanceId: xmlValue(xml, 'instanceId'), InstanceType: xmlValue(xml, 'instanceType'), InstanceLifecycle: xmlValue(xml, 'instanceLifecycle'), Placement: { AvailabilityZone: xmlValue(xml, 'availabilityZone') }, State: { Name: xmlValue(xml, 'instanceState > name') }, PrivateIpAddress: xmlValue(xml, 'privateIpAddress'), PublicIpAddress: xmlValue(xml, 'ipAddress'), Tags: tags }
}
function parseAwsError(xml: string) { return xmlValue(xml, 'Message') ?? 'AWS rejected the request.' }
function xmlValue(xml: string, path: string) { const tag = path.split(' > ').at(-1) ?? path; const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)); return match?.[1] ? decodeXml(match[1]) : undefined }
function decodeXml(value = '') { return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => entity.toLowerCase().startsWith('#x') ? String.fromCodePoint(Number.parseInt(entity.slice(2), 16)) : entity.startsWith('#') ? String.fromCodePoint(Number.parseInt(entity.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()] ?? `&${entity};`)) }
async function signedHeaders(method: string, host: string, payload: string, env: Env) { const now = new Date(), amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), date = amzDate.slice(0, 8), service = 'ec2', scope = `${date}/${env.AWS_REGION}/${service}/aws4_request`, contentType = 'application/x-www-form-urlencoded; charset=utf-8', sessionToken = env.AWS_SESSION_TOKEN, tokenHeader = sessionToken ? `x-amz-security-token:${sessionToken}\n` : '', headers = { host, 'content-type': contentType, 'x-amz-date': amzDate, ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}) }, signed = `content-type;host;x-amz-date${sessionToken ? ';x-amz-security-token' : ''}`, canonical = `${method}\n/\n\ncontent-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\n${tokenHeader}\n${signed}\n${await hash(payload)}`, stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await hash(canonical)}`, signature = await hmacHex(await signingKey(env.AWS_SECRET_ACCESS_KEY, date, env.AWS_REGION, service), stringToSign); return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}` } }
async function signingKey(secret: string, date: string, region: string, service: string) { return hmac(await hmac(await hmac(await hmac(new TextEncoder().encode(`AWS4${secret}`), date), region), service), 'aws4_request') }
async function hmac(key: BufferSource, data: string) { return new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(data))) }
async function hmacHex(key: BufferSource, data: string) { return hex(await hmac(key, data)) }
async function hash(data: string) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))) }
function hex(buffer: ArrayBuffer | Uint8Array) { return [...new Uint8Array(buffer instanceof Uint8Array ? buffer : buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
