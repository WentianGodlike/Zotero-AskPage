/**
 * Ambient types for the shared provider preset data.
 *
 * These are declared globally (not exported from a module) so that
 * `src/data/providers.data.ts` stays a plain script that the settings pane can
 * also load with `Services.scriptloader.loadSubScript`.
 */

interface ProviderModelData {
  /** Model id passed in the request `model` field. */
  id: string;
  /** Whether the model accepts image input. */
  vision?: boolean;
  /** Short hint shown under the model field. */
  note?: string;
}

interface ProviderPresetData {
  /** Stable key persisted in prefs. */
  key: string;
  /** Label shown in the dropdown. */
  label: string;
  /** Base URL without the trailing /chat/completions. */
  baseUrl: string;
  /** Whether the endpoint needs an API key (Ollama does not). */
  requiresKey: boolean;
  /** Where to obtain a key. */
  keyUrl?: string;
  /** True for endpoints on the local machine. */
  local?: boolean;
  /** Default provider-specific request body fields. */
  thinking?: Record<string, unknown>;
  models: ProviderModelData[];
}
