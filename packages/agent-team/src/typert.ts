/** Host RPC registration artifact; the browser imports the same descriptors. */
import { descriptors, TEAM_PACKAGE } from './remote-descriptors.ts'
export const TYPERT = { package: TEAM_PACKAGE, face: 'host', schemas: [], invocations: descriptors, model: { services: [], events: [], objects: [] } }
