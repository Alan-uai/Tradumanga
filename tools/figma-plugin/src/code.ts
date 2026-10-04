type BubbleKind = "dialogue" | "thought" | "shout" | "whisper" | "narration";

type BubbleSpec = {
  kind: BubbleKind;
  label: string;
  fill: string;
  stroke: string;
  strokeWeight: number;
  radius: number;
  width: number;
  height: number;
  fontSize: number;
  fontStyle?: string;
  text: string;
  tail: boolean;
};

const SPECS: Record<BubbleKind, Omit<BubbleSpec, "text">> = {
  dialogue: { kind: "dialogue", label: "Dialogue", fill: "#FFFFFF", stroke: "#111111", strokeWeight: 1, radius: 50, width: 320, height: 150, fontSize: 24, tail: true },
  thought: { kind: "thought", label: "Thought", fill: "#FFFFFF", stroke: "#111111", strokeWeight: 1, radius: 46, width: 320, height: 150, fontSize: 23, fontStyle: "Italic", tail: true },
  shout: { kind: "shout", label: "Shout", fill: "#FFFFFF", stroke: "#111111", strokeWeight: 2, radius: 18, width: 340, height: 160, fontSize: 26, tail: true },
  whisper: { kind: "whisper", label: "Whisper", fill: "#F7F7F7", stroke: "#555555", strokeWeight: 1, radius: 52, width: 310, height: 140, fontSize: 21, fontStyle: "Italic", tail: true },
  narration: { kind: "narration", label: "Narration", fill: "#FFFDF4", stroke: "#111111", strokeWeight: 1, radius: 8, width: 300, height: 110, fontSize: 22, tail: false }
};

const SAMPLE_TEXT: Record<BubbleKind, string> = {
  dialogue: "O que você está fazendo aqui?",
  thought: "Talvez eu devesse esperar...",
  shout: "PARE!",
  whisper: "Não deixe ninguém ouvir.",
  narration: "Naquela noite, tudo mudou."
};

figma.showUI(__html__, { width: 360, height: 560, themeColors: true });

function hexToRgb(hex: string): RGB {
  const value = hex.replace("#", "");
  return { r: parseInt(value.slice(0, 2), 16) / 255, g: parseInt(value.slice(2, 4), 16) / 255, b: parseInt(value.slice(4, 6), 16) / 255 };
}

async function loadFont(style = "Regular"): Promise<void> {
  await figma.loadFontAsync({ family: "Inter", style });
}

function addTail(parent: FrameNode, spec: BubbleSpec): void {
  if (!spec.tail) return;
  const tail = figma.createPolygon();
  tail.pointCount = 3;
  tail.resize(34, 42);
  tail.rotation = 25;
  tail.fills = [{ type: "SOLID", color: hexToRgb(spec.fill) }];
  tail.strokes = [{ type: "SOLID", color: hexToRgb(spec.stroke) }];
  tail.strokeWeight = spec.strokeWeight;
  tail.name = "Tail";
  parent.appendChild(tail);
  tail.x = Math.max(28, spec.width * 0.18);
  tail.y = spec.height - 16;
}

async function createBubble(spec: BubbleSpec, x: number, y: number): Promise<ComponentNode> {
  await loadFont(spec.fontStyle ?? "Regular");

  const frame = figma.createFrame();
  frame.name = "Bubble / " + spec.label;
  frame.resize(spec.width, spec.height);
  frame.x = x;
  frame.y = y;
  frame.cornerRadius = spec.radius;
  frame.fills = [{ type: "SOLID", color: hexToRgb(spec.fill) }];
  frame.strokes = [{ type: "SOLID", color: hexToRgb(spec.stroke) }];
  frame.strokeWeight = spec.strokeWeight;
  frame.clipsContent = false;

  const text = figma.createText();
  text.name = "Translated Text";
  text.fontName = { family: "Inter", style: spec.fontStyle ?? "Regular" };
  text.fontSize = spec.fontSize;
  text.characters = spec.text;
  text.textAlignHorizontal = "CENTER";
  text.textAlignVertical = "CENTER";
  text.fills = [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07 } }];
  text.resize(spec.width - 44, spec.height - 36);
  text.x = 22;
  text.y = 18;
  frame.appendChild(text);

  addTail(frame, spec);

  const component = figma.createComponentFromNode(frame);
  component.name = "Bubble / " + spec.label;
  component.setPluginData("tradumanga:kind", spec.kind);
  component.setPluginData("tradumanga:version", "1.0.0");
  return component;
}

async function createDesignSystem(): Promise<void> {
  figma.currentPage.name = "Tradumanga Bubble System";
  for (const node of figma.currentPage.findAll(n => n.type === "COMPONENT" && n.name.startsWith("Bubble / "))) node.remove();

  const kinds: BubbleKind[] = ["dialogue", "thought", "shout", "whisper", "narration"];
  const components: ComponentNode[] = [];

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    components.push(await createBubble({ ...SPECS[kind], text: SAMPLE_TEXT[kind] }, (i % 2) * 430, Math.floor(i / 2) * 250));
  }

  figma.currentPage.selection = components;
  figma.viewport.scrollAndZoomIntoView(components);
  figma.notify("Tradumanga: 5 componentes de balão criados.");
}

async function createBubbleFromSpec(input: Partial<BubbleSpec>): Promise<ComponentNode> {
  const kind = input.kind ?? "dialogue";
  const base = SPECS[kind];
  const width = input.width ?? base.width;
  const height = input.height ?? base.height;

  return createBubble({
    ...base,
    text: input.text?.trim() || SAMPLE_TEXT[kind],
    width,
    height,
    fill: input.fill ?? base.fill,
    stroke: input.stroke ?? base.stroke,
    fontSize: input.fontSize ?? base.fontSize,
    tail: input.tail ?? base.tail
  }, figma.viewport.center.x - width / 2, figma.viewport.center.y - height / 2);
}

figma.ui.onmessage = async (message: { type: string; kind?: BubbleKind; spec?: Partial<BubbleSpec> }) => {
  try {
    if (message.type === "create-system") await createDesignSystem();
    else if (message.type === "create-bubble") {
      const component = await createBubbleFromSpec({ ...(message.spec ?? {}), kind: message.kind ?? "dialogue" });
      figma.currentPage.selection = [component];
      figma.viewport.scrollAndZoomIntoView([component]);
      figma.notify("Tradumanga: " + component.name + " criado.");
    } else if (message.type === "close") figma.closePlugin();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    figma.notify("Tradumanga: erro — " + detail, { error: true });
  }
};
