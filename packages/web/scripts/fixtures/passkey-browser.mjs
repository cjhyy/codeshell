/** Real Chromium authenticator; controlled Account endpoints. Assertions verify
 * the browser's signature, RP hash, challenge, origin and user-verification bit. */
import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
} from "node:crypto";

export function passkeyBrowserFixture(origin, accountId) {
  const rpId = new URL(origin).hostname;
  const { privateKey, publicKey: initialPublicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  let publicKey = initialPublicKey;
  let id = randomBytes(32).toString("base64url");
  let pending, proof, registration, installed;
  return {
    get id() {
      return id;
    },
    async install(page) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await cdp.send("WebAuthn.addCredential", {
        authenticatorId,
        credential: {
          credentialId: Buffer.from(id, "base64url").toString("base64"),
          isResidentCredential: true,
          rpId,
          privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
          userHandle: Buffer.from(accountId).toString("base64"),
          signCount: 0,
        },
      });
      installed = { cdp, authenticatorId };
      return installed;
    },
    registrationOptions(name) {
      registration = {
        name,
        ceremonyId: randomBytes(32).toString("base64url"),
        challenge: randomBytes(32).toString("base64url"),
      };
      return {
        ceremonyId: registration.ceremonyId,
        optionsJSON: {
          challenge: registration.challenge,
          rp: { id: rpId, name: "CodeShell fixture" },
          user: {
            id: Buffer.from(accountId).toString("base64url"),
            name: "fixture-user",
            displayName: "测试账号",
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 60000,
          attestation: "none",
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          excludeCredentials: [],
        },
      };
    },
    async register(body) {
      assert.equal(body.ceremonyId, registration.ceremonyId);
      const client = JSON.parse(Buffer.from(body.response.response.clientDataJSON, "base64url"));
      assert.equal(client.type, "webauthn.create");
      assert.equal(client.origin, origin);
      assert.equal(client.challenge, registration.challenge);
      const { credentials } = await installed.cdp.send("WebAuthn.getCredentials", {
        authenticatorId: installed.authenticatorId,
      });
      const credential = credentials.find(
        (value) =>
          Buffer.from(value.credentialId, "base64").toString("base64url") === body.response.id,
      );
      assert.ok(credential, "Registration must create a real browser authenticator credential");
      assert.equal(credential.rpId, rpId);
      assert.equal(credential.isResidentCredential, true);
      publicKey = createPublicKey(
        createPrivateKey({
          key: Buffer.from(credential.privateKey, "base64"),
          type: "pkcs8",
          format: "der",
        }),
      );
      id = body.response.id;
      const passkey = { id, name: registration.name, createdAt: Date.now() };
      registration = undefined;
      return { verified: true, passkey };
    },
    options(body) {
      pending = {
        ...body,
        ceremonyId: randomBytes(32).toString("base64url"),
        challenge: randomBytes(32).toString("base64url"),
      };
      return {
        ceremonyId: pending.ceremonyId,
        optionsJSON: {
          rpId,
          challenge: pending.challenge,
          userVerification: "required",
          timeout: 60000,
          allowCredentials: [{ id, type: "public-key", transports: ["internal"] }],
        },
      };
    },
    verify(body) {
      assert.ok(pending, "Verification must follow an options request");
      assert.equal(body.ceremonyId, pending.ceremonyId);
      const response = body.response;
      assert.equal(response.id, id);
      const data = Buffer.from(response.response.clientDataJSON, "base64url");
      const client = JSON.parse(data);
      assert.equal(client.type, "webauthn.get");
      assert.equal(client.origin, origin);
      assert.equal(client.challenge, pending.challenge);
      const auth = Buffer.from(response.response.authenticatorData, "base64url");
      assert.deepEqual(auth.subarray(0, 32), createHash("sha256").update(rpId).digest());
      assert.ok(auth[32] & 0x01, "User presence is required");
      assert.ok(auth[32] & 0x04, "User verification is required");
      assert.ok(
        verify(
          "sha256",
          Buffer.concat([auth, createHash("sha256").update(data).digest()]),
          publicKey,
          Buffer.from(response.response.signature, "base64url"),
        ),
      );
      proof = {
        stepUpToken: randomBytes(32).toString("base64url"),
        purpose: pending.purpose,
        target: pending.target,
      };
      pending = undefined;
      return { stepUpToken: proof.stepUpToken, expiresAt: Date.now() + 60000 };
    },
    consume(value, purpose, target) {
      assert.deepEqual(
        proof,
        { stepUpToken: value, purpose, target },
        "Action must consume its exact Passkey proof",
      );
      proof = undefined;
    },
  };
}
