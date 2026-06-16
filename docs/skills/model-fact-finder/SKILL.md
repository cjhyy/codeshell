---
name: model-fact-finder
description: 当需要查准一个 AI 模型/provider 的接入事实——它支持哪些模态(文本/图片/视频/vision)、有哪些可调参数以及每个参数怎么传(字段名、取值、落到请求体哪里)、上下文窗口多大、怎么鉴权——时使用。典型场景:接入一个新模型前先摸清它的能力,或核实某个模型的参数/上下文是否填对。
---

# Model Fact Finder — 把一家模型的接入事实查准

产出**一份结构化的模型事实报告**:这个模型支持什么模态、有哪些参数、每个参数怎么传、上下文多大、怎么鉴权。这份报告是给下游消费的(填配置、生成接入代码等),本 skill 只负责**查准事实**,不负责怎么用它。

**铁律:绝不凭记忆答。** 模型型号、上下文窗口、参数字段名、API id 都是**会过期、会出错**的事实——必须先 WebSearch 找到该 provider 官方 API 文档,WebFetch 读,再下结论。凭记忆的后果(真实踩过):型号根本不存在、id 拼错、上下文填错、把不支持的参数当支持。查不到就如实说查不到,不要编。

## 查证清单(逐项去官方文档核实)

对目标模型/provider,逐项查实:

1. **真实模型 id** —— API `model` 字段实际接受的字符串。
   - 用当前在售版本,别用记忆里的旧版本或营销名。
   - 网关(OpenRouter 等)的 slug **不等于**原生 id——查网关自己的 models 列表(如 OpenRouter `/api/v1/models`),它可能带日期或有 `~latest` 路由别名。

2. **支持的模态** —— 输入/输出各支持什么:
   - 输入:纯文本?接受图片(vision)?音频?
   - 输出:文本?图片生成?视频生成?
   - vision 要逐模型确认(同家有的支持有的不支持)。

3. **上下文窗口 + 最大输出** —— context window(token 数)和 max output tokens。去官方 pricing/models 文档查准确数值,别估。

4. **可调参数 —— 每个参数查清三样**:
   - **名字 + 语义**:这个参数干什么。
   - **类型/取值**:枚举(列全合法值)、数值(范围/最小值)、布尔开关、自由文本。
   - **怎么传到请求体**:字段名是什么、嵌套在哪。各家差异大,举例:
     - reasoning/思考:OpenAI 是 `reasoning_effort`(枚举 minimal/low/medium/high,gpt-5.5+ 加 xhigh);Anthropic 是 `thinking` 对象(预算 token 数或自适应);DeepSeek 是 `thinking.type` 开关;OpenRouter 归一成统一 `reasoning` 对象(effort 枚举 或 max_tokens 二选一)。
     - 图片:size/quality 的合法枚举值;图生图怎么传参考图。
   - **关键:逐模型判断,别一刀切**。同一家不同模型参数不同(有的有 reasoning、有的没有);不支持某参数就明确标"不支持",别假设。
   - 找文档里的「supported parameters」「API reference」「capabilities」章节;OpenRouter 看 `/api/v1/models` 的 `supported_parameters`(逐模型 string[])。

5. **鉴权 + 端点** —— baseUrl、鉴权方式(Bearer key / 自定义 header / 环境变量)、获取 key 的页面。

## 输出格式

查完按这个结构汇报(每条标注**出处链接**,让人能复核):

```
模型: <显示名> (id: <真实 model id>)
Provider: <家> | 协议: <OpenAI 兼容 / Anthropic 原生 / …>
模态: 输入[文本/图片/…] 输出[文本/图片/视频]
上下文: <context window> | 最大输出: <max output>
鉴权: <方式> | baseUrl: <端点> | 获取 key: <链接>
参数:
  - <名>: <类型> <取值/范围> → 请求体字段 <field>  // <语义/怎么用>
  - <名>: 不支持
出处: <官方文档 URL 列表>
```

不确定的项标「未在文档确认」,不要填猜测值。

## 不要做

- ❌ 凭记忆给型号/上下文/参数(会过期会错——这是本 skill 存在的全部理由)。
- ❌ 把营销名或旧版本当 model id;把网关 slug 当原生 id。
- ❌ 一刀切「这家所有模型都支持 X」——逐模型确认。
- ❌ 越界去管"怎么填进某个配置/写哪个文件"——本 skill 只产出事实报告,落地由下游(catalog 工具等)负责。
