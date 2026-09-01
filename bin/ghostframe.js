#!/usr/bin/env node
import('../dist/server/index.js').catch((err) => {
  console.error('GhostFrame is not built. Run `npm run build` first.')
  console.error(err?.message ?? err)
  process.exit(1)
})
