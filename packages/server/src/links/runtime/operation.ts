import {
  LinkOperationError,
  assertLinkOperationResult,
  getLinkOperationContract,
  snapshotLinkOperationInput,
} from "@cjhyy/code-shell-link";

/** One adapter invocation. Write approval, durable intent and verification belong to the owning controller. */
export async function executeLinkOperation(options: {
  providerId: string;
  action: string;
  params: Record<string, unknown>;
  execute(params: Record<string, unknown>): Promise<unknown>;
  assertAuthorized?(): void;
  signal?: AbortSignal;
}): Promise<unknown> {
  const contract = getLinkOperationContract(options.providerId, options.action);
  if (!contract)
    throw new LinkOperationError(
      "unsupported_contract",
      "This Host does not support the requested operation contract.",
    );
  // Detach input before asynchronous code can observe caller changes.
  const params = snapshotLinkOperationInput(contract, options.params);
  options.signal?.throwIfAborted();
  options.assertAuthorized?.();
  const result = await options.execute(params);
  options.assertAuthorized?.();
  options.signal?.throwIfAborted();
  assertLinkOperationResult(contract, result);
  return result;
}
