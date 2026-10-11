(() => {
  const controls = document.querySelector("#page-translation-controls");
  const languageSelect = document.querySelector("#page-language");
  const approvalCheckbox = document.querySelector("#page-translation-approval");
  const translateButton = document.querySelector("#translate-page");
  const status = document.querySelector("#page-translation-status");
  const sourceTextNodes = new WeakMap();
  const sourceAttributes = new WeakMap();
  const sourceValues = new WeakMap();
  let translating = false;

  if (!controls || !languageSelect || !approvalCheckbox || !translateButton || !status) return;

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function updateButton() {
    translateButton.disabled = translating
      || !languageSelect.value
      || (languageSelect.value !== "en" && !approvalCheckbox.checked);
  }

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      if (parent
        && !parent.closest("script, style, noscript")
        && !parent.closest("textarea, option")
        && !parent.closest("#page-translation-controls")
        && node.nodeValue.trim()) {
        nodes.push(node);
      }
      node = walker.nextNode();
    }
    return nodes;
  }

  function rememberNode(node) {
    if (!sourceTextNodes.has(node)) sourceTextNodes.set(node, node.nodeValue);
    return sourceTextNodes.get(node);
  }

  function rememberAttribute(element, name) {
    let attributes = sourceAttributes.get(element);
    if (!attributes) {
      attributes = new Map();
      sourceAttributes.set(element, attributes);
    }
    if (!attributes.has(name)) attributes.set(name, element.getAttribute(name));
    return attributes.get(name);
  }

  function rememberValue(element) {
    if (!sourceValues.has(element)) sourceValues.set(element, element.value);
    return sourceValues.get(element);
  }

  function makeSnapshot() {
    const originalNodes = collectTextNodes(document.body);
    const clone = document.documentElement.cloneNode(true);
    const cloneNodes = collectTextNodes(clone.querySelector("body"));
    if (originalNodes.length !== cloneNodes.length) {
      throw new Error("Could not prepare all page text for translation.");
    }

    const sourceElements = [...document.querySelectorAll("body *")];
    const cloneElements = [...clone.querySelectorAll("body *")];
    if (sourceElements.length !== cloneElements.length) {
      throw new Error("Could not prepare page controls for translation.");
    }

    const targets = [];
    for (let index = 0; index < originalNodes.length; index += 1) {
      const originalNode = originalNodes[index];
      const cloneNode = cloneNodes[index];
      const source = rememberNode(originalNode);
      const marker = document.createElement("span");
      marker.id = `page-translation-${targets.length}`;
      marker.textContent = source;
      cloneNode.replaceWith(marker);
      targets.push({ type: "text", node: originalNode });
    }

    const markerContainer = document.createElement("div");
    clone.querySelector("body").append(markerContainer);

    const titleNode = document.querySelector("title")?.firstChild;
    if (titleNode?.nodeType === Node.TEXT_NODE && titleNode.nodeValue.trim()) {
      const titleMarker = document.createElement("span");
      titleMarker.id = `page-translation-${targets.length}`;
      titleMarker.textContent = rememberNode(titleNode);
      markerContainer.append(titleMarker);
      targets.push({ type: "text", node: titleNode });
    }

    function addAttributeTarget(element, name, source) {
      if (!source?.trim()) return;
      const marker = document.createElement("span");
      marker.id = `page-translation-${targets.length}`;
      marker.textContent = source;
      markerContainer.append(marker);
      targets.push({ type: "attribute", element, name });
    }

    for (let index = 0; index < sourceElements.length; index += 1) {
      const sourceElement = sourceElements[index];
      const cloneElement = cloneElements[index];
      const tagName = sourceElement.tagName;
      if (sourceElement.closest("#page-translation-controls")) continue;

      if (tagName === "TEXTAREA") {
        const value = rememberValue(sourceElement);
        if (value.trim()) addAttributeTarget(sourceElement, "value", value);
      } else if (tagName === "OPTION") {
        const optionText = sourceElement.firstChild;
        if (optionText?.nodeType === Node.TEXT_NODE) {
          const value = rememberNode(optionText);
          if (value.trim()) addAttributeTarget(sourceElement, "textContent", value);
        }
      }

      if (tagName === "INPUT") {
        const inputType = sourceElement.type;
        if (["button", "reset", "submit"].includes(inputType)) {
          addAttributeTarget(sourceElement, "value", rememberValue(sourceElement));
        }
      }

      for (const attribute of ["placeholder", "title", "aria-label", "alt"]) {
        const value = sourceElement.getAttribute(attribute);
        if (value?.trim()) {
          const original = rememberAttribute(sourceElement, attribute);
          addAttributeTarget(sourceElement, attribute, original);
        }
      }

      if (tagName === "INPUT" && sourceElement.type === "checkbox") {
        cloneElement.checked = sourceElement.checked;
      }
      if (tagName === "SELECT") {
        cloneElement.value = sourceElement.value;
        [...cloneElement.options].forEach((option, optionIndex) => {
          option.selected = sourceElement.options[optionIndex].selected;
        });
      }
    }

    clone.querySelectorAll("textarea").forEach((textarea, index) => {
      const sourceTextarea = document.querySelectorAll("textarea")[index];
      textarea.textContent = sourceTextarea.value;
    });

    clone.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"])')
      .forEach((input, index) => {
        const sourceInput = [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"])')][index];
        if (sourceInput && !["button", "reset", "submit"].includes(sourceInput.type)) {
          input.value = sourceInput.value;
        }
      });

    return {
      html: `<!doctype html>${clone.outerHTML}`,
      targets,
    };
  }

  function restoreEnglish() {
    for (const node of collectTextNodes(document.body)) {
      if (sourceTextNodes.has(node)) node.nodeValue = sourceTextNodes.get(node);
    }
    const titleNode = document.querySelector("title")?.firstChild;
    if (titleNode && sourceTextNodes.has(titleNode)) {
      titleNode.nodeValue = sourceTextNodes.get(titleNode);
    }
    for (const element of document.querySelectorAll("body *")) {
      const attributes = sourceAttributes.get(element);
      if (attributes) {
        for (const [name, value] of attributes) {
          if (value === null) element.removeAttribute(name);
          else element.setAttribute(name, value);
        }
      }
      if (sourceValues.has(element) && (element.tagName === "TEXTAREA" || element.tagName === "INPUT")) {
        element.value = sourceValues.get(element);
      }
      if (element.tagName === "OPTION" && sourceTextNodes.has(element.firstChild)) {
        element.firstChild.nodeValue = sourceTextNodes.get(element.firstChild);
      }
    }
    document.documentElement.lang = "en";
    setStatus("Original English page restored.");
  }

  async function loadLanguages() {
    try {
      const response = await fetch("/api/languages");
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Supported languages could not be loaded.");
      if (!Array.isArray(result.languages) || !result.languages.some(({ code }) => code === "en")) {
        throw new Error("AWS Translate returned an invalid language list.");
      }

      const options = [new Option("English (original)", "en")];
      for (const language of result.languages) {
        if (language.code !== "en") {
          options.push(new Option(`${language.name} (${language.code})`, language.code));
        }
      }
      languageSelect.replaceChildren(...options);
      languageSelect.disabled = false;
      setStatus("Choose a page language.");
    } catch (error) {
      languageSelect.replaceChildren(new Option("Languages unavailable", ""));
      languageSelect.disabled = true;
      setStatus(error.message || "Could not load supported languages.", "error");
    }
    updateButton();
  }

  async function translatePage() {
    if (languageSelect.value === "en") {
      restoreEnglish();
      return;
    }
    if (!languageSelect.value || !approvalCheckbox.checked) {
      updateButton();
      return;
    }

    translating = true;
    updateButton();
    setStatus("Translating the full page…");

    try {
      const { html, targets } = makeSnapshot();
      if (new TextEncoder().encode(html).byteLength > 100_000) {
        throw new Error("This page exceeds AWS TranslateDocument's 100,000-byte limit.");
      }

      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageName: controls.dataset.pageName,
          targetLanguageCode: languageSelect.value,
          html,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "AWS Translate could not translate the page.");

      const translatedDocument = new DOMParser().parseFromString(result.translatedHtml, "text/html");
      targets.forEach((target, index) => {
        const marker = translatedDocument.getElementById(`page-translation-${index}`);
        if (!marker) throw new Error("AWS Translate returned incomplete page text.");
        const translated = marker.textContent;
        if (target.type === "text") {
          target.node.nodeValue = translated;
        } else if (target.name === "textContent") {
          target.element.textContent = translated;
        } else if (target.name === "value") {
          target.element.value = translated;
        } else {
          target.element.setAttribute(target.name, translated);
        }
      });
      document.documentElement.lang = result.targetLanguageCode;
      setStatus(`Page translated to ${result.targetLanguageName}.`);
    } catch (error) {
      setStatus(error.message || "Page translation failed. Try again.", "error");
    } finally {
      translating = false;
      updateButton();
    }
  }

  document.addEventListener("input", (event) => {
    const element = event.target;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      sourceValues.set(element, element.value);
    }
  });
  languageSelect.addEventListener("change", updateButton);
  approvalCheckbox.addEventListener("change", updateButton);
  translateButton.addEventListener("click", () => {
    void translatePage();
  });
  void loadLanguages();
})();
