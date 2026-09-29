import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import React from "react";
import * as coreInternal from "@cjhyy/code-shell-core/internal";
import * as providerFlow from "./ProviderModelFlow.js";
import type { FlowResult, ProviderModelFlowProps } from "./ProviderModelFlow.js";
import { OnboardingPrompt } from "./OnboardingPrompt.js";
import { flush, mount, plainText, type TestHarness } from "../../../../../tests/render-fixtures.js";

describe("onboarding without Arena setup", () => {
  let flowProps: ProviderModelFlowProps;
  let harness: TestHarness | undefined;
  let save: ReturnType<typeof spyOn<typeof coreInternal, "appendOnboardingResult">>;

  beforeEach(() => {
    spyOn(providerFlow, "ProviderModelFlow").mockImplementation((props) => {
      flowProps = props;
      return null;
    });
    spyOn(coreInternal, "detectEnvKeys").mockReturnValue([]);
    save = spyOn(coreInternal, "appendOnboardingResult").mockImplementation(() => {});
  });

  afterEach(() => {
    harness?.unmount();
    harness = undefined;
    mock.restore();
  });

  const result: FlowResult = {
    addedProvider: {
      key: "local-provider",
      kind: "custom",
      baseUrl: "https://fixture.invalid/v1",
    },
    addedModels: ["first", "selected"].map((key) => ({
      key,
      providerKey: "local-provider",
      protocol: "openai",
      provider: "openai",
      model: `fixture/${key}`,
      apiKey: "fixture-key",
      baseUrl: "https://fixture.invalid/v1",
    })),
    activeModelKey: "selected",
  };

  test("finishes a multi-model selection directly and preserves the selected active model", async () => {
    const onComplete = mock(() => {});
    const onCancel = mock(() => {});
    harness = mount(<OnboardingPrompt onComplete={onComplete} onCancel={onCancel} />);
    await flush();

    flowProps.onFinish(result);
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({
      models: result.addedModels.map((model) => ({
        instanceId: model.key,
        kind: "custom",
        model: model.model,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
      })),
      activeId: "selected",
    });
    expect(onComplete).toHaveBeenCalledWith({
      key: "selected",
      provider: "openai",
      model: "fixture/selected",
      apiKey: "fixture-key",
      baseUrl: "https://fixture.invalid/v1",
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(plainText(harness)).not.toContain("Arena");
  });

  test("cancels an empty model selection without saving or completing", async () => {
    const onComplete = mock(() => {});
    const onCancel = mock(() => {});
    harness = mount(<OnboardingPrompt onComplete={onComplete} onCancel={onCancel} />);
    await flush();

    flowProps.onFinish({ addedModels: [] });
    await flush();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  test("retains a failed selection and retries saving it on Enter", async () => {
    save.mockImplementationOnce(() => {
      throw new Error("settings file is unreadable");
    });
    const onComplete = mock(() => {});
    const onCancel = mock(() => {});
    harness = mount(<OnboardingPrompt onComplete={onComplete} onCancel={onCancel} />);
    await flush();

    flowProps.onFinish(result);
    await flush();
    expect(plainText(harness)).toContain("settings file is unreadable");
    expect(onComplete).not.toHaveBeenCalled();

    // The input handler refreshes in a passive effect after the error renders.
    await new Promise((resolve) => setTimeout(resolve, 75));
    harness.stdin.write("\u001b[13u");
    await flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
