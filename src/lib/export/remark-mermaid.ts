import type { Plugin } from "unified";
import type { Root, Code, Image, Paragraph, Parent } from "mdast";
import { visit } from "unist-util-visit";

let mermaidInitialized = false;

async function initMermaid() {
  if (mermaidInitialized) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, theme: "default" });
  mermaidInitialized = true;
}

let renderCounter = 0;

async function renderMermaidToPng(code: string): Promise<string | null> {
  try {
    await initMermaid();
    const { default: mermaid } = await import("mermaid");
    const { toPng } = await import("html-to-image");

    const id = `mermaid-export-${renderCounter++}`;
    const { svg } = await mermaid.render(id, code);

    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.top = "0";
    container.style.left = "0";
    container.style.background = "white";
    container.style.zIndex = "99999";
    container.style.pointerEvents = "none";
    container.innerHTML = svg;
    document.body.appendChild(container);

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      const svgEl = container.querySelector("svg");
      let pixelRatio = window.devicePixelRatio || 2;

      if (svgEl) {
        const viewBox = svgEl.viewBox?.baseVal;
        const intrinsicWidth =
          (viewBox && viewBox.width > 0 ? viewBox.width : 0) ||
          parseFloat(svgEl.style.maxWidth) ||
          parseFloat(svgEl.getAttribute("width") || "0");
        const displayedWidth = container.offsetWidth;
        if (intrinsicWidth > 0 && displayedWidth > 0) {
          pixelRatio = Math.max(pixelRatio, (intrinsicWidth / displayedWidth) * 1.5);
        }
      }

      pixelRatio = Math.min(pixelRatio, 8);

      return await toPng(container, { backgroundColor: "#ffffff", pixelRatio });
    } finally {
      document.body.removeChild(container);
    }
  } catch (err) {
    console.warn("Mermaid render failed:", err);
    return null;
  }
}

const remarkMermaid: Plugin<[], Root> = () => {
  return async (tree: Root) => {
    const mermaidNodes: { node: Code; index: number; parent: Parent }[] = [];

    visit(tree, "code", (node: Code, index, parent) => {
      if (node.lang === "mermaid" && index !== undefined && parent) {
        mermaidNodes.push({ node, index, parent: parent as Parent });
      }
    });

    for (const { node, index, parent } of mermaidNodes) {
      const pngDataUrl = await renderMermaidToPng(node.value);
      if (pngDataUrl) {
        const imageNode: Image = {
          type: "image",
          url: pngDataUrl,
          alt: "Mermaid diagram",
        };
        const wrappedNode: Paragraph = {
          type: "paragraph",
          children: [imageNode],
        };
        parent.children[index] = wrappedNode;
      }
    }
  };
};

export default remarkMermaid;
