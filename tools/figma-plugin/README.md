# Tradumanga Bubble Studio

Plugin de desenvolvimento do Tradumanga para modelar e testar o sistema visual de balões no Figma.

## Primeira versão

- Cria Dialogue, Thought, Shout, Whisper e Narration.
- Cada balão é um ComponentNode.
- Cada componente recebe pluginData com tipo e versão.
- Permite criar um balão individual pela UI.
- O contrato já aceita o formato que será produzido pela análise do Gemini.

## Desenvolvimento

Requisitos: Figma Desktop, Node.js e npm.

    cd tools/figma-plugin
    npm install
    npm run build

No Figma Desktop:
1. Abra um arquivo de Design.
2. Vá em Plugins > Development > Import plugin from manifest...
3. Selecione tools/figma-plugin/manifest.json.
4. Execute Tradumanga Bubble Studio.

O fluxo segue o modelo recomendado pelo Figma: TypeScript + @figma/plugin-typings, manifesto com documentAccess dynamic-page e build local.

## Contrato preparado

{
  kind: "dialogue" | "thought" | "shout" | "whisper" | "narration",
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  tail?: boolean,
  fill?: string,
  stroke?: string,
  fontSize?: number
}

A próxima camada pode conectar esse contrato ao endpoint do Tradumanga que recebe a análise do Gemini.
