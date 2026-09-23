import { useCallback, useEffect, useState } from 'react'

type State = 'running' | 'stopped' | 'pending' | 'stopping' | 'starting' | 'unknown'
type ToggleAction = 'start' | 'stop'
type Instance = { id: string; name: string; type: string; state: State; lifecycle?: string; privateIp?: string; publicIp?: string }
type ApiResponse = { instances?: Instance[]; zone?: string; error?: string }
type PendingAction = { instance: Instance; action: ToggleAction }

export function App() {
  const [instances, setInstances] = useState<Instance[]>([])
  const [zone, setZone] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const [sshInstance, setSshInstance] = useState<Instance | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)

  const loadInstances = useCallback(async () => {
    setError('')
    try {
      const response = await fetch('/api/instances')
      const data = await response.json() as ApiResponse
      if (!response.ok) throw new Error(data.error ?? 'Could not load instances.')
      setInstances(data.instances ?? [])
      setZone(data.zone ?? '')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load instances.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadInstances() }, [loadInstances])

  function toggleInstance(instance: Instance) {
    const action: ToggleAction = instance.state === 'running' ? 'stop' : 'start'
    if (!['running', 'stopped'].includes(instance.state)) return
    setPendingAction({ instance, action })
  }

  async function confirmToggle() {
    if (!pendingAction) return
    const { instance, action } = pendingAction
    setPendingAction(null)
    setBusyId(instance.id)
    setError('')
    try {
      const response = await fetch(`/api/instances/${instance.id}/${action}`, { method: 'POST' })
      const data = await response.json() as ApiResponse
      if (!response.ok) throw new Error(data.error ?? `Could not ${action} ${instance.name}.`)
      await loadInstances()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : `Could not ${action} instance.`)
    } finally {
      setBusyId('')
    }
  }

  function showSshCommand(instance: Instance) {
    setCopiedId('')
    setSshInstance(instance)
  }

  async function copySshCommand() {
    if (!sshInstance?.publicIp) return
    const command = `chmod 400 "students.pem"\nssh -i "students.pem" ec2-user@${sshInstance.publicIp}`
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(command)
      else {
        const textarea = document.createElement('textarea')
        textarea.value = command
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.append(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      setCopiedId(sshInstance.id)
      window.setTimeout(() => setCopiedId((current) => current === sshInstance.id ? '' : current), 1800)
    } catch {
      setError('Could not copy the SSH command.')
    }
  }

  return (
    <main className="instances-page">
      <h1>instances</h1>
      <p className="zone">{zone}</p>
      {loading && <p className="message">Loading…</p>}
      {error && <p className="message error">{error}</p>}
      {!loading && !error && instances.length === 0 && <p className="message">No matching instances.</p>}
      {!loading && instances.length > 0 && (
        <section className="instance-list" aria-label="EC2 instances">
          {instances.map((instance) => {
            const actionable = instance.state === 'running' || instance.state === 'stopped'
            const running = instance.state === 'running'
            return (
              <article className="instance" key={instance.id}>
                <div>
                  <h2>{instance.name}</h2>
                  <p>{instance.id} · {instance.type} · {instance.publicIp ?? instance.privateIp ?? 'no IP'}{instance.lifecycle === 'spot' ? ' · spot' : ''}</p>
                </div>
                <div className="instance-action">
                  <span className={running ? 'state running' : 'state'}>{instance.state}</span>
                  <div className="instance-buttons">
                    <button onClick={() => toggleInstance(instance)} disabled={!actionable || busyId === instance.id}>
                      {busyId === instance.id ? 'Working…' : running ? 'Stop' : 'Start'}
                    </button>
                    <button className="copy-button" onClick={() => showSshCommand(instance)} disabled={!instance.publicIp} title={instance.publicIp ? 'Show SSH command' : 'No public IP available'}>
                      Show SSH
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </section>
      )}
      {sshInstance?.publicIp && (
        <div className="ssh-backdrop" role="presentation" onClick={() => setSshInstance(null)}>
          <section className="ssh-modal" role="dialog" aria-modal="true" aria-labelledby="ssh-title" onClick={(event) => event.stopPropagation()}>
            <div className="ssh-modal-header">
              <div>
                <p className="ssh-label">SSH COMMAND</p>
                <h2 id="ssh-title">{sshInstance.name}</h2>
              </div>
              <button className="close-button" onClick={() => setSshInstance(null)} aria-label="Close SSH commands">×</button>
            </div>
            <pre>{`chmod 400 "students.pem"\nssh -i "students.pem" ec2-user@${sshInstance.publicIp}`}</pre>
            <div className="ssh-modal-actions">
              <button className="copy-button" onClick={() => void copySshCommand()}>
                {copiedId === sshInstance.id ? 'Copied' : 'Copy commands'}
              </button>
              <button onClick={() => setSshInstance(null)}>Close</button>
            </div>
          </section>
        </div>
      )}
      {pendingAction && (
        <div className="confirm-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <section
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-description"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="ssh-label">CONFIRM ACTION</p>
            <h2 id="confirm-title">
              {pendingAction.action === 'stop' ? 'Stop' : 'Start'} instance?
            </h2>
            <p id="confirm-description" className="confirm-message">
              Are you sure you want to {pendingAction.action} “{pendingAction.instance.name}”?
            </p>
            <div className="ssh-modal-actions">
              <button className="copy-button" onClick={() => setPendingAction(null)}>Cancel</button>
              <button onClick={() => void confirmToggle()}>
                {pendingAction.action === 'stop' ? 'Stop instance' : 'Start instance'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
