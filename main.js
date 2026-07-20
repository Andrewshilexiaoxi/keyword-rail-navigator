const { MarkdownView, Notice, Plugin, PluginSettingTab, Setting, requestUrl } = require("obsidian");

const DEFAULT_SETTINGS = {
  mode: "headings",
  provider: "deepseek",
  apiKey: "",
  model: "deepseek-v4-flash",
  volcengineBaseUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  minCharacters: 900,
  cache: {}
};

class KeywordRailNavigator extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.rail = null;
    this.currentFile = null;
    this.refreshTimer = null;
    this.scrollTracker = null;
    this.addSettingTab(new KeywordRailSettings(this.app, this));
    this.addCommand({ id: "refresh-ai-keyword-navigation", name: "刷新当前文档的 AI 关键词导航", callback: () => this.refreshAiKeywords(true) });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRender()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path === this.currentFile?.path) this.scheduleRender();
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRender()));
    this.scheduleRender();
  }

  onunload() { this.destroyRail(); }
  async saveSettings() { await this.saveData(this.settings); this.scheduleRender(); }
  scheduleRender() { window.clearTimeout(this.refreshTimer); this.refreshTimer = window.setTimeout(() => this.renderRail(), 180); }

  getMarkdownView() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file?.extension === "md" ? view : null;
  }

  destroyRail() { this.stopScrollTracking(); this.rail?.remove(); this.rail = null; this.currentFile = null; }

  async renderRail() {
    const view = this.getMarkdownView();
    if (!view) return this.destroyRail();
    const host = view.containerEl.querySelector(".view-content") || view.containerEl;
    if (!this.rail || !host.contains(this.rail)) {
      this.destroyRail();
      this.rail = host.createDiv({ cls: "keyword-rail-navigator" });
    }
    this.currentFile = view.file;
    const items = this.settings.mode === "ai" ? await this.getAiItems(view.file) : this.getHeadingItems(view.file);
    this.rail.empty();
    this.rail.toggleClass("krn-mode-headings", this.settings.mode === "headings");
    this.rail.toggleClass("krn-mode-ai", this.settings.mode === "ai");
    const switcher = this.rail.createDiv({ cls: "krn-mode-switch", attr: { "aria-label": "切换导航模式" } });
    this.createModeButton(switcher, "headings", "标题", "☷", "按 H2、H3 标题导航");
    this.createModeButton(switcher, "ai", "AI", "✦", "按 AI 内容关键词导航");
    if (this.settings.mode === "ai") {
      const refresh = this.rail.createEl("button", { cls: "krn-refresh", text: items.length ? "↻ 重新提取" : "↻ 提取关键词" });
      refresh.title = "为当前文档提取或重新提取 AI 内容关键词";
      refresh.addEventListener("click", () => this.refreshAiKeywords(true));
    }
    const navigationEntries = [];
    for (const item of items) {
      const button = this.rail.createEl("button", { cls: "krn-item", text: item.label });
      button.dataset.level = String(item.level || 1);
      button.dataset.mode = this.settings.mode;
      button.title = item.label;
      const entry = { button, line: item.line };
      navigationEntries.push(entry);
      button.addEventListener("click", () => {
        this.setActiveNavigationItem(navigationEntries, navigationEntries.indexOf(entry));
        this.jumpTo(view, item.line);
      });
    }
    this.startScrollTracking(view, navigationEntries);
  }

  startScrollTracking(view, entries) {
    this.stopScrollTracking();
    if (!entries.length) return;
    const scroller = this.findDocumentScroller(view);
    if (!scroller) return;
    let animationFrame = null;
    const update = () => {
      animationFrame = null;
      this.updateActiveNavigationItem(view, scroller, entries);
    };
    const onScroll = () => {
      if (animationFrame === null) animationFrame = window.requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    this.scrollTracker = { scroller, onScroll, animationFrame };
    onScroll();
  }

  stopScrollTracking() {
    if (!this.scrollTracker) return;
    this.scrollTracker.scroller.removeEventListener("scroll", this.scrollTracker.onScroll);
    if (this.scrollTracker.animationFrame !== null) window.cancelAnimationFrame(this.scrollTracker.animationFrame);
    this.scrollTracker = null;
  }

  findDocumentScroller(view) {
    const candidates = [
      view.containerEl.querySelector(".cm-scroller"),
      view.containerEl.querySelector(".markdown-preview-view"),
      view.containerEl.querySelector(".view-content"),
      view.containerEl
    ].filter(Boolean);
    return candidates.find((element) => element.scrollHeight > element.clientHeight + 2) || candidates[0];
  }

  updateActiveNavigationItem(view, scroller, entries) {
    // 点击跳转会把模块开头放在屏幕中央，因此高亮也必须以屏幕中央为判断点。
    const markerY = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    const editorLine = this.getVisibleEditorLine(view, markerY);
    if (editorLine !== null) {
      let activeIndex = 0;
      entries.forEach((entry, index) => { if (entry.line <= editorLine) activeIndex = index; });
      this.setActiveNavigationItem(entries, activeIndex);
      return;
    }
    const elementsByLine = [...view.containerEl.querySelectorAll("[data-line]")]
      .map((element) => ({ element, line: Number(element.dataset.line) }))
      .filter((item) => Number.isFinite(item.line));
    const targets = entries.map((entry) => {
      const target = elementsByLine.find((item) => item.line >= entry.line);
      return target ? target.element.getBoundingClientRect().top : null;
    });
    let activeIndex = -1;
    if (targets.some((target) => target !== null)) {
      targets.forEach((target, index) => { if (target !== null && target <= markerY) activeIndex = index; });
      if (activeIndex < 0) activeIndex = targets.findIndex((target) => target !== null);
    } else {
      const maxLine = Math.max(...entries.map((entry) => entry.line), 1);
      const progress = scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      const estimatedLine = progress * maxLine;
      entries.forEach((entry, index) => { if (entry.line <= estimatedLine) activeIndex = index; });
      if (activeIndex < 0) activeIndex = 0;
    }
    this.setActiveNavigationItem(entries, activeIndex);
  }

  getVisibleEditorLine(view, markerY) {
    const lines = [...view.containerEl.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
      .map((element) => ({ line: Number(element.textContent.trim()) - 1, top: element.getBoundingClientRect().top }))
      .filter((item) => Number.isInteger(item.line));
    if (!lines.length) return null;
    let current = lines[0].line;
    for (const item of lines) {
      if (item.top <= markerY) current = item.line;
      else break;
    }
    return current;
  }

  setActiveNavigationItem(entries, activeIndex) {
    entries.forEach((entry, index) => entry.button.toggleClass("is-active", index === activeIndex));
    const activeButton = entries[activeIndex]?.button;
    if (!activeButton || !this.rail) return;
    const top = activeButton.offsetTop;
    const bottom = top + activeButton.offsetHeight;
    if (top < this.rail.scrollTop) this.rail.scrollTop = top - 4;
    else if (bottom > this.rail.scrollTop + this.rail.clientHeight) this.rail.scrollTop = bottom - this.rail.clientHeight + 4;
  }

  createModeButton(host, mode, text, icon, title) {
    const button = host.createEl("button", { cls: "krn-mode-button", text });
    button.dataset.mode = mode;
    button.dataset.icon = icon;
    button.title = title;
    button.toggleClass("is-active", this.settings.mode === mode);
    button.addEventListener("click", async () => {
      if (this.settings.mode === mode) return;
      this.settings.mode = mode;
      await this.saveSettings();
    });
  }

  getHeadingItems(file) {
    const headings = this.app.metadataCache.getFileCache(file)?.headings || [];
    return headings
      .filter((heading) => heading.level === 2 || heading.level === 3)
      .map((heading) => ({ label: heading.heading.replace(/#+\s*/g, "").trim(), line: heading.position.start.line, level: heading.level }));
  }

  async getAiItems(file) {
    const content = await this.app.vault.read(file);
    const stored = this.settings.cache[file.path];
    // 已生成的导航是用户主动保存的结果；正文改动不自动清除或重提取。
    // 仅重新计算每块的行号，尽量让微调后的跳转位置仍保持准确。
    if (stored?.items?.length) {
      const segments = splitIntoContentSegments(content, this.settings.minCharacters);
      return stored.items.map((item, index) => ({ ...item, line: segments[index]?.line ?? item.line }));
    }
    return [];
  }

  async refreshAiKeywords(force) {
    const view = this.getMarkdownView();
    if (!view) return new Notice("请先打开一篇 Markdown 文档。");
    if (this.settings.mode !== "ai") return new Notice("请先在设置中切换到「AI 内容关键词导航」。");
    if (!this.settings.apiKey.trim()) return new Notice("请先在插件设置中填写 API Key。");
    const content = await this.app.vault.read(view.file);
    const hash = simpleHash(content);
    if (!force && this.settings.cache[view.file.path]?.hash === hash) return;
    const segments = splitIntoContentSegments(content, this.settings.minCharacters);
    if (!segments.length) return new Notice("当前文档内容较少，暂无可提取的内容块。");
    new Notice(`正在提取 ${segments.length} 个内容关键词…`);
    try {
      const labels = [];
      for (const segment of segments) labels.push(await this.extractKeyword(segment.text));
      this.settings.cache[view.file.path] = { hash, items: segments.map((segment, i) => ({ label: labels[i], line: segment.line, level: 1 })), updatedAt: Date.now() };
      await this.saveData(this.settings);
      new Notice("AI 关键词导航已更新。");
      await this.renderRail();
    } catch (error) {
      console.error("Keyword Rail Navigator AI request failed", error);
      new Notice(`关键词提取失败：${error.message || "请检查 API 设置"}`);
    }
  }

  async extractKeyword(text) {
    const endpoint = this.settings.provider === "volcengine" ? this.settings.volcengineBaseUrl.trim() : "https://api.deepseek.com/chat/completions";
    const model = this.settings.model.trim() || (this.settings.provider === "volcengine" ? "" : "deepseek-v4-flash");
    const requestBody = {
      model,
      temperature: 0.15,
      // 关键词不需要推理；关闭思考可减少等待时间与输出 token 消耗。
      max_tokens: 24,
      messages: [
        { role: "system", content: "你是中文文档导航助手。只输出一个极短的具体内容关键词（2到8个汉字或一个专名），不要标点、引号或解释。优先提取人物、具体主题、事件、对象或文本核心内容；禁止输出宏观题型/框架词，如：阅读理解、完形填空、教学设计、练习题、总结。" },
        { role: "user", content: `请为下面这块内容取一个用于导航的具体关键词：\n\n${text.slice(0, 5000)}` }
      ]
    };
    if (this.settings.provider === "deepseek") requestBody.thinking = { type: "disabled" };
    const response = await requestUrl({
      url: endpoint,
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.settings.apiKey.trim()}` },
      body: JSON.stringify(requestBody)
    });
    const result = response.json?.choices?.[0]?.message?.content?.trim();
    if (!result) throw new Error("服务商没有返回关键词");
    return result.replace(/[“”"'`，。；：、.!！?？\n]/g, "").slice(0, 16) || "内容主题";
  }

  findElementForLine(view, line) {
    const elements = [...view.containerEl.querySelectorAll("[data-line]")]
      .map((element) => ({ element, line: Number(element.dataset.line) }))
      .filter((item) => Number.isFinite(item.line));
    return elements.find((item) => item.line >= line)?.element || view.containerEl.querySelector(".cm-active");
  }

  centerElementInView(view, line) {
    const scroller = this.findDocumentScroller(view);
    const target = this.findElementForLine(view, line);
    if (!scroller || !target) return false;
    const targetRect = target.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const targetTop = scroller.scrollTop + targetRect.top - scrollerRect.top;
    const centeredTop = Math.max(0, targetTop - (scroller.clientHeight - targetRect.height) / 2);
    scroller.scrollTo({ top: centeredTop, behavior: "smooth" });
    return true;
  }

  async jumpTo(view, line) {
    const editor = view.editor;
    if (editor) {
      editor.setCursor({ line, ch: 0 });
      editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      window.setTimeout(() => this.centerElementInView(view, line), 40);
      return;
    }
    if (this.centerElementInView(view, line)) return;
    await view.leaf.openFile(view.file, { active: true, eState: { line } });
    window.setTimeout(() => this.centerElementInView(view, line), 40);
  }
}

class KeywordRailSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "极简关键词导航" });
    new Setting(containerEl).setName("导航模式").setDesc("标题模式仅使用 H2、H3（无需 API）；AI 模式按文章内容提炼具体主题词。").addDropdown((dropdown) => dropdown.addOption("headings", "第一档：标题（H2、H3，无需 API）").addOption("ai", "第二档：AI 关键词").setValue(this.plugin.settings.mode).onChange(async (value) => { this.plugin.settings.mode = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("AI 服务商").addDropdown((dropdown) => dropdown.addOption("deepseek", "DeepSeek").addOption("volcengine", "火山引擎（方舟）").setValue(this.plugin.settings.provider).onChange(async (value) => { this.plugin.settings.provider = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("API Key").setDesc("仅保存于本机的 Obsidian 插件数据中。").addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey).onChange(async (value) => { this.plugin.settings.apiKey = value; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName("模型名称").setDesc("DeepSeek 默认 deepseek-chat；火山引擎请填你的 Endpoint ID。").addText((text) => text.setPlaceholder("deepseek-chat 或 ep-...").setValue(this.plugin.settings.model).onChange(async (value) => { this.plugin.settings.model = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("火山引擎接口地址").setDesc("默认适用于方舟 OpenAI 兼容 Chat Completions 接口。").addText((text) => text.setValue(this.plugin.settings.volcengineBaseUrl).onChange(async (value) => { this.plugin.settings.volcengineBaseUrl = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("AI 分段长度").setDesc("每块约多少字符。数值越小，导航越细；推荐 900。 ").addText((text) => text.setValue(String(this.plugin.settings.minCharacters)).onChange(async (value) => { this.plugin.settings.minCharacters = Math.max(300, Number(value) || 900); await this.plugin.saveSettings(); }));
  }
}

function splitIntoContentSegments(content, limit) {
  const lines = content.replace(/^---[\s\S]*?---\s*/m, "").split("\n");
  const pieces = []; let buffer = []; let start = 0;
  const flush = () => { const text = buffer.join("\n").replace(/^#+\s+.*$/gm, "").trim(); if (text.length > 80) pieces.push({ line: start, text }); buffer = []; };
  lines.forEach((line, index) => {
    if (/^#{1,6}\s+/.test(line) && buffer.join("\n").length > 300) { flush(); start = index; }
    if (!buffer.length) start = index;
    buffer.push(line);
    if (buffer.join("\n").length >= limit && /^\s*$/.test(line)) flush();
  });
  flush();
  return pieces;
}

function simpleHash(value) { let hash = 2166136261; for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(36); }

module.exports = KeywordRailNavigator;
