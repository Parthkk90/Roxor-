import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Tunnelling the dev server is opt-in via `TUNNEL=1`, never the default.
 *
 * A tunnel gives the dev server a hostname Vite has never heard of, and Vite rejects unknown `Host`
 * headers - that check is DNS-rebinding protection, so relaxing it is a real (if small) loosening
 * and should not be something an ordinary `npm run dev` silently turns on.
 *
 * Note what a tunnel actually publishes: the dev server inlines every `VITE_*` variable into the
 * bundle it serves. Anything secret in `.env.local` - `VITE_SUBGRAPH_URL` embeds a billable Graph
 * API key - becomes readable by anyone who opens the link. Unset those vars for the tunnelled run
 * rather than relying on nobody looking.
 */
const tunnelling = process.env.TUNNEL === '1'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: tunnelling
    ? {
        host: true, // bind 0.0.0.0 so the tunnel client can reach it
        allowedHosts: true, // accept the tunnel's generated hostname, whatever it turns out to be
      }
    : undefined,
})
