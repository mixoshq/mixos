export interface SsoConfigState {
  error: string | null;
  success: string | null;
}

export const INITIAL_SSO_CONFIG_STATE: SsoConfigState = {
  error: null,
  success: null,
};
