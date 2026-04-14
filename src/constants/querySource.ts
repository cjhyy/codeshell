/**
 * Source of a query — identifies where the query was initiated from.
 */
export type QuerySource =
  | 'repl'
  | 'cli'
  | 'sdk'
  | 'bridge'
  | 'remote'
  | 'agent'
  | 'coordinator'
  | 'task'
  | 'hook'
  | 'resume'
