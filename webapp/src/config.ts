/**
 * Configuration for the Flame Tree Visualizer
 */

/**
 * OpenCode web UI configuration
 * The URL pattern is: {baseUrl}/{base64ProjectPath}/session/{sessionID}
 */
export const openCodeConfig = {
  /** Base URL for OpenCode web UI (e.g., http://127.0.0.1:49260) */
  baseUrl: "http://127.0.0.1:49173",

  /** Project path (will be base64 encoded in URLs) */
  projectPath: "/Users/sl/code/flame",
};

/**
 * Generate OpenCode web UI URL for a session
 * Note: OpenCode uses base64 without padding (no trailing '=' chars)
 */
export function getOpenCodeSessionUrl(sessionID: string): string {
  const base64Path = btoa(openCodeConfig.projectPath).replace(/=+$/, "");
  return `${openCodeConfig.baseUrl}/${base64Path}/session/${sessionID}`;
}

/**
 * Data source configuration
 */
export const dataConfig = {
  /** Use mock data instead of real API */
  useMock: false,

  /** API endpoint for flame state (when useMock is false) */
  apiEndpoint: "/api/flame/state",

  /** Poll interval in ms (0 to disable) */
  pollInterval: 5000,
};
