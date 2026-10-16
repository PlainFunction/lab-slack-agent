import { imageTools, noteTools, timeTools, type ToolsContext, type ToolServer } from '#capabilities'

/**
 * The tool servers that run inside this Worker. Add your own here, or deploy
 * one as its own Worker with serveMcp and list its binding in MCP_BINDINGS.
 */
export const tools = ({ env, cipher, timeZone, vision }: ToolsContext): ToolServer[] => [
  timeTools(timeZone),
  noteTools(env.KV, cipher),
  imageTools(vision),
]
