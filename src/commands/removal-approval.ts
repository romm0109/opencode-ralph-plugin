/** Ordinary-chat authorization belongs only to previewed project removal. */
export function approvesRemoval(text: string) {
  return /^(?:approve(?:d)?(?: (?:it|this|the proposal|removal))?|yes(?:[, ]+(?:please|proceed|do it|go ahead|remove it))?|go ahead|looks good|proceed|do it)[.!]?$/i.test(
    text.trim(),
  );
}
export interface RemovalReceipt {
  messageId: string;
  text: string;
  requests: Set<string>;
}
