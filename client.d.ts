import type { Options } from 'pusher-js';

export interface Member<Info = any> {
  id: string;
  /** user_info signed by your auth endpoint. */
  info: Info | null;
  me: boolean;
}

/** cluster "hkg", wsHost "ws.hibira.io", forceTLS, ws/wss transports. */
export const HIBIRA_DEFAULTS: Options;

/** Your pusher-js options merged over HIBIRA_DEFAULTS. */
export function hibiraOptions(options?: Partial<Options>): Options;
