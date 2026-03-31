import type { Command } from '../../commands.js'

const codespaces: Command = {
  name: 'codespaces',
  aliases: ['workspace-ui', 'copilot-ui'],
  description:
    'Open a Codespaces-like workspace interface for coding assistant workflows',
  type: 'local-jsx',
  load: () => import('./codespaces.js'),
}

export default codespaces