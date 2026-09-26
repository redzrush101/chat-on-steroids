import { z } from 'zod';
import { BROWSER_BRIDGE_PORTS } from '../shared/browser-bridge.js';
import { CHAT_BROWSERS } from '../shared/types.js';
import { appearanceSchema } from './appearance-schema.js';

export const browserBridgePortSchema = z.union([z.literal('auto'), z.literal(BROWSER_BRIDGE_PORTS)]);

/** Raw UI setting validators shared by persisted config and renderer settings IPC. */
export const uiSettingSchemas = {
  appearance: appearanceSchema,
  autoContinue: z.boolean(),
  chatBrowser: z.enum(CHAT_BROWSERS),
  developerMode: z.boolean(),
  finishTool: z.boolean(),
  planBackend: z.enum(['chatgpt', 'api']),
  finishAction: z.enum(['notify', 'goal']),
  finishLeadMinutes: z.number().int().min(3).max(5),
  backgroundChats: z.boolean(),
  browserBridgePort: browserBridgePortSchema,
  browserOnly: z.boolean(),
  autoRefreshPlugins: z.boolean(),
  tabsToKeepOpen: z.number().int().min(1).max(50),
  minimizeToTray: z.boolean(),
  autoConnect: z.boolean(),
  startAtLogin: z.boolean(),
  privacyScreenshots: z.boolean(),
  theme: z.enum(['light', 'dark'])
};
