import { describe, expect, test } from "bun:test";
import { asGlobalFetch } from "../testing/fetch-stub.js";
import { allowsLinkAction } from "./authority.js";
import { getLocalLinkProvider } from "./providers.js";
import {
  FIGMA_ACTIONS,
  FIGMA_RESPONSE_BYTES,
  normalizeFigmaActionResult,
  parseFigmaFileInput,
} from "./figma.js";
import { linkRequestJson } from "./http.js";
import {
  normalizeRemoteLinkActionResult,
  prepareRemoteLinkAction,
  reviewedRemoteLinkActions,
} from "./remote-adapters.js";

const file = "FileOne";
const groups = [{ id: "files", items: [{ id: file, label: "Selected file" }] }];
const design = {
  name: "Design",
  version: "123",
  editorType: "figma",
  thumbnailUrl: "https://example.test/thumbnail.png",
  document: {
    id: "0:0",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        type: "CANVAS",
        name: "Page",
        children: [
          {
            id: "1:2",
            type: "FRAME",
            name: "Header",
            layoutMode: "HORIZONTAL",
            absoluteBoundingBox: { x: 10, y: 20, width: 400, height: 80 },
            fills: [{ type: "IMAGE", imageRef: "image-ref" }],
            children: [
              {
                id: "1:3",
                type: "TEXT",
                characters: "完整设计文字",
                style: { fontFamily: "Inter", fontSize: 20 },
                boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "Variable:1" }] },
                fillGeometry: [{ path: "M0 0L1 1", windingRule: "NONZERO" }],
                pluginData: { "123": { custom: "retained" } },
              },
            ],
          },
        ],
      },
    ],
  },
  components: { "2:3": { key: "component", name: "Button" } },
  componentSets: { "2:4": { key: "set", name: "Buttons" } },
  styles: { "3:4": { key: "style", name: "Heading", styleType: "TEXT" } },
  schemaVersion: 0,
  branches: [{ key: "BranchOne", name: "Alternate" }],
  accessToken: "must never relay arbitrary top-level fields",
};

async function local(action: string, params: Record<string, unknown>, response: unknown) {
  let request: URL | undefined;
  let headers: Headers | undefined;
  const result = await getLocalLinkProvider("figma")!
    .actions.find((item) => item.id === action)!
    .execute({
      token: "synthetic-private",
      params,
      fetchImpl: asGlobalFetch(async (input, init) => {
        request = new URL(String(input));
        expect(request.origin).toBe("https://api.figma.com");
        headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    });
  return { result, request: request!, headers: headers! };
}

describe("Figma full design reads", () => {
  test("an explicitly requested full file keeps all document content, components, and styles", async () => {
    const { result, request, headers } = await local(
      "get_file",
      { file_key: file, full: true },
      design,
    );
    expect(request.pathname).toBe(`/v1/files/${file}`);
    expect(request.searchParams.has("depth")).toBe(false);
    expect(headers.get("X-Figma-Token")).toBe("synthetic-private");
    expect(request.searchParams.has("full")).toBe(false);
    expect(result).toMatchObject({
      document: design.document,
      components: design.components,
      componentSets: design.componentSets,
      styles: design.styles,
      branches: design.branches,
      pages: [{ id: "0:1", name: "Page", type: "CANVAS" }],
    });
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("truncated");
    expect(
      normalizeRemoteLinkActionResult(
        "figma",
        "get_file",
        design,
        { file_key: file, full: true },
        groups,
      ),
    ).toEqual(result);
  });

  test("get_file defaults to depth two while full false remains a structure request", async () => {
    for (const params of [{ file_key: file }, { file_key: file, full: false }]) {
      const { result, request } = await local("get_file", params, design);
      expect(request.searchParams.get("depth")).toBe("2");
      expect(request.searchParams.has("full")).toBe(false);
      expect(result).toHaveProperty("requestedDepth", 2);
      expect(result).not.toHaveProperty("requestedFull");
      expect(prepareRemoteLinkAction("figma", "get_file", params, groups)).toEqual({
        file_url_or_key: file,
        depth: 2,
      });
    }
    expect(
      prepareRemoteLinkAction("figma", "get_file", { file_key: file, full: true }, groups),
    ).toEqual({ file_url_or_key: file, full: true });
  });

  test("file options and URL node-id are normalized identically for local and remote", async () => {
    const params = {
      file_url_or_key: `https://www.figma.com/design/${file}/Name?node-id=1-2`,
      depth: "4",
      version: "123",
      geometry: "paths",
      plugin_data: ["123", "shared"],
      branch_data: true,
    };
    const { result, request } = await local("get_file", params, design);
    expect(Object.fromEntries(request.searchParams)).toEqual({
      ids: "1:2",
      version: "123",
      depth: "4",
      geometry: "paths",
      plugin_data: "123,shared",
      branch_data: "true",
    });
    expect(prepareRemoteLinkAction("figma", "get_file", params, groups)).toEqual({
      file_url_or_key: file,
      ids: "1:2",
      version: "123",
      depth: 4,
      geometry: "paths",
      plugin_data: "123,shared",
      branch_data: true,
    });
    expect(result).toMatchObject({ requestedDepth: 4, requestedNodeIds: ["1:2"] });
    expect(result).not.toHaveProperty("truncated");
  });

  test("get_nodes keeps full subtree data and missing-node null entries", async () => {
    const raw = {
      name: "Design",
      nodes: {
        "1:2": {
          document: design.document.children[0].children[0],
          components: design.components,
          styles: design.styles,
        },
        "9:9": null,
      },
      secret: "omit",
    };
    const params = { file_key: file, node_ids: ["1-2", "9:9"], depth: 2, geometry: "paths" };
    const { result, request } = await local("get_nodes", params, raw);
    expect(request.pathname).toBe(`/v1/files/${file}/nodes`);
    expect(request.searchParams.get("ids")).toBe("1:2,9:9");
    expect(result).toMatchObject({
      nodes: raw.nodes,
      requestedDepth: 2,
      requestedNodeIds: ["1:2", "9:9"],
    });
    expect(result).not.toHaveProperty("secret");
    expect(normalizeRemoteLinkActionResult("figma", "get_nodes", raw, params, groups)).toEqual(
      result,
    );
  });

  test("get_images uses the official render endpoint with bounded export parameters", async () => {
    const params = {
      file_key: file,
      ids: "1-2,1:2,9:9",
      scale: "0.01",
      format: "svg",
      svg_outline_text: false,
      svg_include_id: true,
      svg_include_node_id: true,
      svg_simplify_stroke: false,
      use_absolute_bounds: true,
      contents_only: false,
      version: "123",
    };
    const raw = {
      err: null,
      images: { "1:2": "https://example.test/export.svg", "9:9": null },
      privateToken: "omit",
      requestedNodeIds: ["999:999"],
    };
    const { result, request } = await local("get_images", params, raw);
    expect(request.pathname).toBe(`/v1/images/${file}`);
    expect(request.searchParams.get("ids")).toBe("1:2,9:9");
    expect(request.searchParams.get("scale")).toBe("0.01");
    expect(request.searchParams.get("svg_outline_text")).toBe("false");
    expect(request.searchParams.get("use_absolute_bounds")).toBe("true");
    expect(result).toEqual({ err: null, images: raw.images, requestedNodeIds: ["1:2", "9:9"] });
    expect(normalizeRemoteLinkActionResult("figma", "get_images", raw, params, groups)).toEqual(
      result,
    );
  });

  test("image fill references survive both Figma response envelope variants", async () => {
    for (const raw of [
      { images: { ref: "https://example.test/fill.png" } },
      { status: 200, meta: { images: { ref: "https://example.test/fill.png" }, secret: "omit" } },
    ]) {
      const { result, request } = await local("get_image_fills", { file_key: file }, raw);
      expect(request.pathname).toBe(`/v1/files/${file}/images`);
      expect(request.search).toBe("");
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(
        normalizeRemoteLinkActionResult(
          "figma",
          "get_image_fills",
          raw,
          { file_key: file },
          groups,
        ),
      ).toEqual(result);
    }
  });

  test("get_file rejects responses that omit document instead of accepting pages-only summaries", () => {
    expect(() =>
      normalizeFigmaActionResult(
        "get_file",
        { name: "Old", pages: [{ id: "0:1" }], truncated: true },
        { file_url_or_key: file },
      ),
    ).toThrow("no document content");
  });

  test("pages and comments beyond the old summary cap remain available", async () => {
    const pages = Array.from({ length: 101 }, (_, index) => ({
      id: `${index}:1`,
      type: "CANVAS",
      name: `Page ${index}`,
    }));
    const fileResult = await local(
      "get_file",
      { file_key: file },
      { name: "Many pages", document: { id: "0:0", type: "DOCUMENT", children: pages } },
    );
    expect(fileResult.result).toHaveProperty("pages", pages);
    const comments = Array.from({ length: 101 }, (_, index) => ({
      id: String(index),
      message: `Comment ${index}`,
      parent_id: index === 0 ? null : "0",
      order_id: String(index),
      file_key: file,
    }));
    const commentResult = await local("get_comments", { file_key: file }, { comments });
    expect(commentResult.result).toEqual({ comments });
    expect(
      normalizeRemoteLinkActionResult(
        "figma",
        "get_comments",
        { comments },
        { file_key: file },
        groups,
      ),
    ).toEqual({ comments });
  });

  test("each action checks the exact file grant and new actions need explicit capabilities", () => {
    for (const action of FIGMA_ACTIONS) {
      const params = {
        file_key: "OtherFile",
        ...(["get_nodes", "get_images"].includes(action) ? { ids: ["1:2"] } : {}),
      };
      expect(() => prepareRemoteLinkAction("figma", action, params, groups)).toThrow("授权");
    }
    for (const capabilityIds of [undefined, [], ["figma.get_file", "figma.get_comments"]]) {
      const credential = {
        id: "legacy",
        type: "link" as const,
        label: "Legacy",
        hasSecret: true,
        meta: {
          linkProvider: "figma",
          linkExecutionRuntime: "local" as const,
          linkCapabilityIds: capabilityIds,
        },
      };
      expect(allowsLinkAction(credential, "figma", "get_file")).toBe(true);
      for (const action of ["get_nodes", "get_images", "get_image_fills"])
        expect(allowsLinkAction(credential, "figma", action)).toBe(false);
    }
    expect(reviewedRemoteLinkActions("figma", ["get_file", "get_comments"])).toEqual([
      "get_file",
      "get_comments",
    ]);
    expect(reviewedRemoteLinkActions("figma", FIGMA_ACTIONS)).toEqual(FIGMA_ACTIONS);
  });

  test("Make links fail as unsupported types before resource authorization", () => {
    const url = "https://www.figma.com/make/MakeOne/Prototype";
    expect(() => parseFigmaFileInput(url)).toThrow("Make");
    try {
      prepareRemoteLinkAction("figma", "get_file", { file_url_or_key: url }, groups);
    } catch (error) {
      expect(error).toHaveProperty("code", "unsupported_file_type");
      return;
    }
    throw new Error("Make link must fail");
  });

  test("invalid fields, unsafe URLs and unbounded selections fail before a local request", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["get_file", { depth: 0 }],
      ["get_file", { depth: 101 }],
      ["get_file", { depth: 1.5 }],
      ["get_file", { full: "true" }],
      ["get_file", { full: null }],
      ["get_file", { full: true, depth: 2 }],
      ["get_file", { full: false, depth: 2 }],
      ["get_nodes", { full: true, ids: "1:2" }],
      ["get_file", { ids: Array.from({ length: 51 }, (_, id) => `1:${id}`) }],
      ["get_file", { ids: [] }],
      ["get_file", { ids: null }],
      ["get_file", { node_ids: null }],
      ["get_file", { file_url_or_key: null }],
      ["get_file", { file_url_or_key: null, file_key: file }],
      ["get_file", { file_url_or_key: undefined, file_key: null }],
      ["get_file", { ids: "1:2,,1:3" }],
      ["get_file", { ids: "1:2", node_ids: ["1:3"] }],
      ["get_file", { version: "../../other" }],
      ["get_file", { geometry: "raw" }],
      ["get_file", { plugin_data: ["arbitrary"] }],
      ["get_file", { branch_data: "true" }],
      ["get_nodes", { branch_data: true, ids: ["1:2"] }],
      ["get_nodes", {}],
      ["get_images", { ids: "1:2", scale: 4.01 }],
      ["get_images", { ids: "1:2", scale: "Infinity" }],
      ["get_images", { ids: "1:2", format: "html" }],
      ["get_images", { ids: "1:2", svg_include_id: 1 }],
      ["get_image_fills", { version: "123" }],
      ["get_file", { token: "forbidden" }],
      ...[
        "http://figma.com/design/FileOne",
        "https://figma.com.evil.test/design/FileOne",
        "https://user@figma.com/design/FileOne",
        "https://figma.com:8443/design/FileOne",
        "https://figma.com/design/FileOne%2Fother",
        "https://figma.com/design/FileOne?node-id=1-2&node-id=3-4",
        "..",
      ].map((url): [string, Record<string, unknown>] => ["get_file", { file_url_or_key: url }]),
    ];
    let calls = 0;
    for (const [action, params] of cases) {
      const input = { file_url_or_key: file, ...params };
      await expect(
        getLocalLinkProvider("figma")!
          .actions.find((item) => item.id === action)!
          .execute({
            token: "synthetic",
            params: input,
            fetchImpl: asGlobalFetch(async () => {
              calls += 1;
              throw new Error("Unexpected request");
            }),
          }),
      ).rejects.toThrow();
      expect(() => prepareRemoteLinkAction("figma", action, input, groups)).toThrow();
    }
    expect(calls).toBe(0);
  });

  test("Figma accepts documents above 1 MiB and returns actionable overflow without partial data", async () => {
    const larger = {
      ...design,
      document: { ...design.document, description: "x".repeat(2 * 1024 * 1024) },
    };
    expect((await local("get_file", { file_key: file, full: true }, larger)).result).toHaveProperty(
      "document.description",
      larger.document.description,
    );
    await expect(
      local(
        "get_file",
        { file_key: file, full: true },
        {
          ...design,
          document: { ...design.document, description: "x".repeat(FIGMA_RESPONSE_BYTES) },
        },
      ),
    ).rejects.toThrow("get_nodes");
    await expect(
      linkRequestJson({
        url: new URL("https://api.github.com/user"),
        headers: {},
        fetchImpl: asGlobalFetch(
          async () => new Response(JSON.stringify({ value: "x".repeat(1024 * 1024) })),
        ),
      }),
    ).rejects.toThrow("1048576");
  });
});
