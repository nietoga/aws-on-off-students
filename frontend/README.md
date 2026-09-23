# AWS Switch

Small Vite + React app for starting and stopping EC2 instances whose Name tag contains `arqui`, in the configured AWS region and availability zone. The browser talks to `/api`; AWS credentials stay inside the Cloudflare Worker.

## Local development

Create `frontend/.env`:

```dotenv
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_SESSION_TOKEN=...
AWS_REGION=us-east-1
AWS_ZONE=us-east-1a
```

Then run `pnpm dev:frontend`. This builds the UI and starts the local Worker on port 3000. The Worker discovers instances with `DescribeInstances`, keeps only instances in `AWS_ZONE` whose Name tag contains `arqui`, and the UI displays that result.

## Deploy

Set the same values as Cloudflare secrets/vars, then run `pnpm deploy:frontend`.

```bash
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
wrangler secret put AWS_SESSION_TOKEN
```

`AWS_REGION` and `AWS_ZONE` may be regular Cloudflare variables. Use an IAM principal limited to `ec2:DescribeInstances`, `ec2:StartInstances`, and `ec2:StopInstances`.
