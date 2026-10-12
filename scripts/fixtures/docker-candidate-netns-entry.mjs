import {
  applyCandidateFirewall,
  firewallNativeCommand,
  candidateHelperInventory,
  firewallNegativeProbe,
} from "../docker-candidate-netns.mjs";

if (process.platform !== "linux" || process.argv.length !== 3)
  throw new Error("Namespace helper requires exact Linux policy");
const policy = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
await applyCandidateFirewall(policy, {
  run: firewallNativeCommand,
  probe: firewallNegativeProbe,
  publish(receipt) {
    // NET_ADMIN-only root cannot write the runtime UID's private HOME. The
    // trusted controller verifies this receipt and invokes its fixed writer.
    console.log(JSON.stringify({ ...receipt, inventory: candidateHelperInventory() }));
  },
});
