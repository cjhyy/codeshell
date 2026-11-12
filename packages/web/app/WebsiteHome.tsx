import React from "react";
import { parseAccountSession } from "./account-api.js";
import "./website-home.css";

const repository = "https://github.com/cjhyy/codeshell";
const examples = [
  {
    label: "学习与研究",
    name: "新的学习计划",
    task: "帮我把这个学习目标拆成可执行的计划，并整理成文档。",
    reply:
      "先明确目标和现有基础，再把学习过程拆成阶段。我们可以在同一个工作区逐步补充资料、记录问题、更新计划。",
    files: ["学习目标.md", "阶段计划.md", "资料与笔记/"],
    title: "把大目标，拆成下一步。",
    detail: "在对话里梳理问题，在文件中留下成果。下次回来时，继续同一份计划。",
  },
  {
    label: "产品与内容",
    name: "一个产品想法",
    task: "把我的产品想法整理成需求文档，列出还需要确认的问题。",
    reply:
      "先梳理使用场景与用户需求，再整理功能边界和待确认问题。文档与讨论保留在当前工作区，方便继续修改。",
    files: ["需求草案.md", "待确认问题.md", "参考资料/"],
    title: "让讨论，有可以接着做的成果。",
    detail: "从模糊想法到需求草案，结合对话、项目文件和工具，把思路逐步写清楚。",
  },
  {
    label: "编程与开发",
    name: "我的开发项目",
    task: "先阅读这个项目，说明结构，再为我要做的功能提出实现方案。",
    reply:
      "从项目文件和现有实现开始，理解模块之间的关系，再整理修改步骤。涉及工具执行时，按当前工作区权限处理。",
    files: ["实现方案.md", "src/", "tests/"],
    title: "在项目里理解，也在项目里推进。",
    detail: "桌面端与终端提供代码、文件和工具上下文，让分析、修改与检查围绕同一个项目展开。",
  },
];

export function WebsiteHome() {
  const [signedIn, setSignedIn] = React.useState(false);
  const [example, setExample] = React.useState(0);
  const demo = examples[example]!;
  // A read-only enhancement: public content renders immediately even if Account
  // is offline. Visiting the homepage never creates Cloud authority or projects.
  React.useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/account/web/session", {
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const session = parseAccountSession(await response.json());
        if (!controller.signal.aborted) setSignedIn(session.authenticated);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return (
    <div className="public-site">
      <a className="public-skip" href="#main">
        跳到内容
      </a>
      <header className="public-header">
        <a className="public-brand" href="/" aria-label="CodeShell 官网">
          <span aria-hidden="true">›_</span>CodeShell
        </a>
        <nav aria-label="官网导航">
          <a href="#workspace">工作区</a>
          <a href="#capabilities">能力</a>
          <a href="#start">开始使用</a>
          <a href={`${repository}#readme`} target="_blank" rel="noreferrer">
            文档 <span aria-hidden="true">↗</span>
          </a>
        </nav>
        <a className="public-nav-action" href={signedIn ? "/app" : "/login"}>
          {signedIn ? "进入工作台" : "登录"}
          <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main id="main">
        <section className="public-hero" aria-labelledby="public-title">
          <div className="public-hero-copy">
            <p className="public-eyebrow">
              <span /> 开源 AI Agent 工作空间
            </p>
            <h1 id="public-title">
              从一个想法开始。
              <br />
              <em>把它做下去。</em>
            </h1>
            <p className="public-lead">
              让对话、文件、模型与工具在同一个工作区协作。
              <br className="public-desktop-break" />
              从一个问题开始，逐步推进你的研究、创作与开发。
            </p>
            <div className="public-actions">
              <a className="public-button primary" href={signedIn ? "/app" : "/signup"}>
                {signedIn ? "进入工作台" : "开始使用网页版"}
                <span aria-hidden="true">→</span>
              </a>
              <a
                className="public-button"
                href={`${repository}/releases`}
                target="_blank"
                rel="noreferrer"
              >
                下载桌面端 <span aria-hidden="true">↗</span>
              </a>
            </div>
            <p className="public-hero-note">选择自己的模型服务 · 按项目保存工作 · MIT 开源</p>
          </div>
          <div className="public-hero-note-card" aria-hidden="true">
            <span>FROM AN IDEA</span>
            <div className="public-note-line" />
            <strong>
              一个问题。
              <br />
              一份计划。
              <br />
              下一步行动。
            </strong>
            <span className="public-note-bottom">
              TO YOUR NEXT STEP <b>↘</b>
            </span>
          </div>
        </section>

        <section id="workspace" className="public-workspace" aria-labelledby="workspace-title">
          <div className="public-section-heading">
            <div>
              <p className="public-eyebrow">01 / 在工作区里，让事情接着发生</p>
              <h2 id="workspace-title">
                想法有了上下文，
                <br />
                工作就有了连续性。
              </h2>
            </div>
            <p>
              一个项目保存自己的对话、文件和模型配置。
              <br />
              从第一次提问，到下一次继续，都有迹可循。
            </p>
          </div>
          <div className="public-demo-tabs" role="group" aria-label="选择工作区示例">
            {examples.map((item, index) => (
              <button
                key={item.label}
                aria-pressed={example === index}
                onClick={() => setExample(index)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="public-demo" aria-label={`${demo.label}工作区示意`}>
            <div className="public-demo-bar">
              <div>
                <span />
                <span />
                <span />
              </div>
              <span>CodeShell / {demo.name}</span>
              <span>界面示意</span>
            </div>
            <div className="public-demo-body">
              <aside className="public-demo-sidebar">
                <span className="public-demo-logo">
                  ›_ <strong>CodeShell</strong>
                </span>
                <span className="public-demo-new">＋ 新对话</span>
                <span className="selected">◌ 对话</span>
                <span>▤ 历史对话</span>
                <span>▱ 文件</span>
                <span>✧ Skills</span>
                <span>◈ 面板</span>
                <span>⚙ 设置</span>
                <small>当前工作区</small>
                <strong>{demo.name}</strong>
              </aside>
              <div className="public-demo-chat">
                <div className="public-demo-workspace-name">
                  {demo.name}
                  <span>示意对话</span>
                </div>
                <p className="public-demo-question">{demo.task}</p>
                <div className="public-demo-answer">
                  <b>›_</b>
                  <p>{demo.reply}</p>
                </div>
                <div className="public-demo-outline">
                  <span>任务思路</span>
                  <p>理解目标与上下文</p>
                  <p>整理计划与项目文件</p>
                  <p>根据反馈继续推进</p>
                </div>
                <div className="public-demo-composer">
                  <span>继续描述你的想法…</span>
                  <div>
                    <span>
                      ＋ <small>你选择的模型</small>
                    </span>
                    <b>↑</b>
                  </div>
                </div>
              </div>
              <aside className="public-demo-files">
                <span>工作区文件</span>
                {demo.files.map((file) => (
                  <p key={file}>
                    ▱ <span>{file}</span>
                  </p>
                ))}
                <div>
                  <small>留在工作区里的成果</small>
                  <p>
                    文件与对话一起，
                    <br />
                    成为下次工作的起点。
                  </p>
                </div>
              </aside>
            </div>
          </div>
          <div className="public-demo-caption">
            <div aria-live="polite">
              <h3>{demo.title}</h3>
              <p>{demo.detail}</p>
            </div>
            <small>
              以上为功能与内容示意，非实际运行结果。
              <br />
              可用工具取决于运行环境、已安装能力与授权。
            </small>
          </div>
        </section>

        <section
          id="capabilities"
          className="public-capabilities"
          aria-labelledby="capabilities-title"
        >
          <div className="public-capabilities-intro">
            <p className="public-eyebrow">02 / 按你的工作方式组合</p>
            <h2 id="capabilities-title">
              模型是起点。
              <br />
              工作区，让能力连接起来。
            </h2>
            <p>用你需要的模型和工具，构建适合当前任务的工作环境。从简单对话开始，按需扩展。</p>
            <a
              className="public-text-link"
              href={`${repository}#features`}
              target="_blank"
              rel="noreferrer"
            >
              查看完整能力说明 ↗
            </a>
          </div>
          <dl className="public-capability-list">
            <div>
              <dt>
                <span>01</span>模型由你选择
              </dt>
              <dd>
                添加服务商、模型名称和 API Key，设置默认对话模型。凭据与设置由当前运行环境管理。
              </dd>
            </div>
            <div>
              <dt>
                <span>02</span>工具按需接入
              </dt>
              <dd>
                通过 Skills、MCP
                与插件扩展能力，使用文件、浏览器和其他工具。执行遵循所在环境的权限设置。
              </dd>
            </div>
            <div>
              <dt>
                <span>03</span>对话之外，还有工作面板
              </dt>
              <dd>
                在工作台里查看文件、使用面板、回看历史。桌面端还提供终端、浏览器与代码审阅等工作界面。
              </dd>
            </div>
            <div>
              <dt>
                <span>04</span>从一次任务，到持续推进
              </dt>
              <dd>
                底层引擎提供任务、子
                Agent、定时任务与持久目标；桌面端和终端可承接需要多步骤推进的工作。
              </dd>
            </div>
          </dl>
        </section>

        <section className="public-surfaces" aria-labelledby="surfaces-title">
          <div className="public-section-heading">
            <div>
              <p className="public-eyebrow">03 / 选择适合你的入口</p>
              <h2 id="surfaces-title">
                在浏览器开始，
                <br />
                也可以留在自己的电脑。
              </h2>
            </div>
            <p>
              网页版、桌面端与终端，
              <br />
              面向不同的运行环境，使用同一个 Agent 引擎。
            </p>
          </div>
          <div className="public-surface-list">
            <article>
              <span>01 / WEB</span>
              <h3>随时打开的云端工作区</h3>
              <p>
                登录网站后创建项目，在云端独立运行环境中管理对话、文件和配置。适合从浏览器开始。
              </p>
              <a href={signedIn ? "/app" : "/signup"}>
                {signedIn ? "进入工作台" : "创建网页账号"} <span aria-hidden="true">→</span>
              </a>
            </article>
            <article>
              <span>02 / DESKTOP</span>
              <h3>把工作带回桌面</h3>
              <p>
                围绕本地项目展开工作，使用模型管理、扩展、面板与自动化。按设备系统选择发布版本。
              </p>
              <a href={`${repository}/releases`} target="_blank" rel="noreferrer">
                查看桌面端下载 <span aria-hidden="true">↗</span>
              </a>
            </article>
            <article>
              <span>03 / CLI & SDK</span>
              <h3>融入现有开发流程</h3>
              <p>在终端交互运行或执行单次任务，也可以通过 SDK 将 Agent 引擎接入自己的产品。</p>
              <code>npx @cjhyy/code-shell</code>
              <a href={`${repository}#quick-start`} target="_blank" rel="noreferrer">
                阅读快速开始 <span aria-hidden="true">↗</span>
              </a>
            </article>
          </div>
        </section>

        <section id="start" className="public-start" aria-labelledby="start-title">
          <div>
            <p className="public-eyebrow">从这里开始</p>
            <h2 id="start-title">
              把第一个想法，
              <br />
              交给一个工作区。
            </h2>
            <p>
              网页版的开始方式很简单。模型服务与 API Key
              由你自行提供，使用费用按所选服务商规则计算。
            </p>
            <a className="public-button primary" href={signedIn ? "/app" : "/signup"}>
              {signedIn ? "进入工作台" : "创建账号，开始使用"} <span aria-hidden="true">→</span>
            </a>
          </div>
          <ol>
            <li>
              <span>1</span>
              <div>
                <h3>创建账号</h3>
                <p>使用用户名和密码注册；已开放的其他登录方式会显示在登录页。</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>建立第一个工作区</h3>
                <p>给项目起个名字，准备独立的对话、文件和运行环境。</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>连接模型，开始对话</h3>
                <p>添加模型连接并选择默认模型，再描述你想完成的任务。</p>
              </div>
            </li>
          </ol>
        </section>

        <section className="public-faq" aria-labelledby="faq-title">
          <h2 id="faq-title">开始之前，你可能想知道</h2>
          <div>
            <details>
              <summary>需要自己准备模型吗？</summary>
              <p>
                需要。网页版创建工作区后，你可以填写模型服务商、模型名称和 API
                Key，再选择默认对话模型。模型调用费用由你选择的服务商收取。
              </p>
            </details>
            <details>
              <summary>网页版和桌面端有什么区别？</summary>
              <p>
                网页版项目在云端运行。桌面端围绕你的本地项目工作，并提供桌面面板、扩展与自动化入口。文件和配置属于对应的工作环境，不会因为登录同一账号就自动迁移。
              </p>
            </details>
            <details>
              <summary>可以阅读源码或自行运行吗？</summary>
              <p>
                可以。CodeShell 采用 MIT 许可证，源码、快速开始和发布版本均在
                GitHub。自托管及开发方式请阅读仓库文档。
              </p>
            </details>
          </div>
        </section>
      </main>
      <footer className="public-footer">
        <div>
          <a className="public-brand" href="/">
            <span aria-hidden="true">›_</span>CodeShell
          </a>
          <p>让想法有上下文，让工作继续。</p>
        </div>
        <nav aria-label="页脚导航">
          <a href={signedIn ? "/app" : "/login"}>{signedIn ? "进入工作台" : "登录"}</a>
          <a href={`${repository}/releases`} target="_blank" rel="noreferrer">
            下载
          </a>
          <a href={`${repository}#readme`} target="_blank" rel="noreferrer">
            文档
          </a>
          <a href={repository} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={`${repository}/issues`} target="_blank" rel="noreferrer">
            反馈问题
          </a>
        </nav>
        <div className="public-footer-bottom">
          <span>CodeShell · MIT License</span>
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
            沪ICP备2026060456号-1
          </a>
        </div>
      </footer>
    </div>
  );
}
