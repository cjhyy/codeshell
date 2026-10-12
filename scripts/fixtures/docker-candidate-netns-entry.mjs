import {
  applyCandidateFirewall,
  firewallNativeCommand,
  publishCandidateFirewall,
  candidateHelperInventory,
} from "../docker-candidate-netns.mjs";

if (process.platform !== "linux" || process.argv.length !== 3)
  throw new Error("Namespace helper requires exact Linux policy");
const policy = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
const receipt = await applyCandidateFirewall(policy, {
  run: firewallNativeCommand,
  publish: publishCandidateFirewall,
});
console.log(JSON.stringify({ ...receipt, helperInventory: candidateHelperInventory() }));
