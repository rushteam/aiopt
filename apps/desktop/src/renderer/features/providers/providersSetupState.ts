/** Setup guide: only while the provider pool has never been filled (nothing configured yet). */
export function shouldShowProvidersSetupGuide(input: { poolEmpty: boolean }): boolean {
  return input.poolEmpty;
}
