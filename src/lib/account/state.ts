export interface AccountActionState {
  error: string | null;
  success: string | null;
}

export const INITIAL_ACCOUNT_STATE: AccountActionState = {
  error: null,
  success: null,
};
