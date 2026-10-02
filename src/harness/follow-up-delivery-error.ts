/** Acceptance can be unknown even when the backend request failed locally. */
export class FollowUpDeliveryUnconfirmedError extends Error {
  constructor() {
    super("Follow-up delivery was not confirmed. OCA did not queue a fallback. Check session output before deciding whether to send again.");
    this.name = "FollowUpDeliveryUnconfirmedError";
  }
}
