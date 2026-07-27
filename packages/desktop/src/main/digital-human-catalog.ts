import type { WorkspaceProfile } from "@cjhyy/code-shell-core";

export interface DigitalHumanCatalogEntry extends WorkspaceProfile {
  category: "product" | "design" | "engineering" | "quality";
  tags: string[];
  samplePrompts: string[];
}

/**
 * 内置起始目录。
 *
 * **当前为空，这是有意的。** 原先硬编码的 8 个数字人除一句 mainInstruction 外
 * plugins/skills/mcp/agents 全是空数组，basePreset 也几乎一致——彼此没有任何能力
 * 差异，选了等于没选。它们还带着编造的 usageCount（12800 / 9600 …）并真的渲染成
 * "12.8k 次使用"，对一个从未发布过的本地目录而言是虚假的社会证明。两者一并移除。
 *
 * 数字人改由「自带依赖」的定义提供：见 core `profile/requirements.ts` 的
 * `requires` 字段（声明 skill/工具来源，安装时经用户确认后获取），配合已有的
 * 导入/导出（`previewProfileDefinitionImport` / `exportProfileDefinition`）分发。
 * 保留本常量与读取模型，是为了让远程目录接上来时不必改 IPC 契约。
 */
export const DIGITAL_HUMAN_CATALOG: readonly DigitalHumanCatalogEntry[] = [] as const;
