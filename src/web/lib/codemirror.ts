// Editor de código (CodeMirror 6) com cores no estilo do VS Code e linguagens carregadas sob demanda.
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  scrollPastEnd,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import {
  HighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentUnit,
  LanguageDescription,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';

const darkColors = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#c586c0' },
  { tag: [t.definitionKeyword, t.bool, t.null, t.atom, t.self], color: '#569cd6' },
  { tag: [t.string, t.special(t.string), t.character], color: '#ce9178' },
  { tag: [t.regexp], color: '#d16969' },
  { tag: [t.number, t.integer, t.float], color: '#b5cea8' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#6a9955', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#dcdcaa' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: '#4ec9b0' },
  { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName], color: '#9cdcfe' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: '#9cdcfe' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: '#4fc1ff' },
  { tag: [t.tagName], color: '#569cd6' },
  { tag: [t.angleBracket], color: '#808080' },
  { tag: [t.heading], color: '#569cd6', fontWeight: 'bold' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.link, t.url], color: '#4daafc', textDecoration: 'underline' },
  { tag: [t.meta, t.processingInstruction], color: '#9b9b9b' },
  { tag: [t.invalid], color: '#f44747' },
  { tag: [t.inserted], color: '#89d185' },
  { tag: [t.deleted], color: '#f48771' },
  { tag: [t.escape], color: '#d7ba7d' },
]);

const lightColors = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#af00db' },
  { tag: [t.definitionKeyword, t.bool, t.null, t.atom, t.self], color: '#0000ff' },
  { tag: [t.string, t.special(t.string), t.character], color: '#a31515' },
  { tag: [t.regexp], color: '#811f3f' },
  { tag: [t.number, t.integer, t.float], color: '#098658' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#008000', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#795e26' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: '#267f99' },
  { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName], color: '#001080' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: '#0070c1' },
  { tag: [t.tagName], color: '#800000' },
  { tag: [t.heading], color: '#0000ff', fontWeight: 'bold' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.link, t.url], color: '#005fb8', textDecoration: 'underline' },
  { tag: [t.meta], color: '#6e7681' },
  { tag: [t.invalid], color: '#cd3131' },
]);

function baseTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': { color: 'var(--fg)', backgroundColor: 'var(--bg)', height: '100%' },
      '.cm-content': { caretColor: dark ? '#aeafad' : '#000', padding: '4px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: dark ? '#aeafad' : '#000', borderLeftWidth: '2px' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: dark ? '#264f78 !important' : '#add6ff !important',
      },
      '.cm-activeLine': { backgroundColor: dark ? '#ffffff0a' : '#0000000a' },
      '.cm-gutters': { backgroundColor: 'var(--bg)', color: dark ? '#6e7681' : '#237893', border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: dark ? '#cccccc' : '#0b216f' },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px', minWidth: '40px' },
      '.cm-foldGutter .cm-gutterElement': { color: 'var(--fg-muted)', cursor: 'pointer' },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: dark ? '#0064001a' : '#0064001a', outline: `1px solid ${dark ? '#888' : '#b9b9b9'}` },
      '.cm-selectionMatch': { backgroundColor: dark ? '#add6ff26' : '#add6ff80' },
      '.cm-searchMatch': { backgroundColor: dark ? '#623315' : '#ffd54f80', outline: '1px solid #d18616' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: dark ? '#9e6a03' : '#ffb300' },
      '.cm-panels': { backgroundColor: 'var(--bg-widget)', color: 'var(--fg)', borderBottom: '1px solid var(--border-strong)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-strong)' },
      '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: 'var(--ui-font)' },
      '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'var(--ui-font)', fontSize: '12px' },
      '.cm-textfield': { backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-strong)', borderRadius: '2px', color: 'var(--fg)' },
      '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-strong)', color: 'var(--fg)' },
      '.cm-tooltip': { backgroundColor: 'var(--bg-widget)', border: '1px solid var(--border-strong)', color: 'var(--fg)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--bg-active-focus)', color: 'var(--fg-strong)' },
      '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-input)', border: 'none', color: 'var(--fg-muted)' },
    },
    { dark },
  );
}

/** Linguagem pelo nome do arquivo (carregada sob demanda). */
export async function languageFor(filename: string): Promise<Extension> {
  const lower = filename.toLowerCase();
  let desc = LanguageDescription.matchFilename(languages, filename);
  if (!desc) {
    const special: Record<string, string> = {
      dockerfile: 'Dockerfile',
      makefile: 'Shell',
      '.env': 'Properties files',
      '.bashrc': 'Shell',
      '.zshrc': 'Shell',
      '.profile': 'Shell',
      caddyfile: 'Nginx',
      'nginx.conf': 'Nginx',
      '.gitignore': 'Shell',
    };
    const base = lower.replace(/^.*[\\/]/, '');
    const name = special[base] ?? (base.endsWith('.conf') ? 'Nginx' : base.endsWith('.service') || base.endsWith('.ini') ? 'Properties files' : base.endsWith('.jsonl') ? 'JSON' : undefined);
    if (name) desc = LanguageDescription.matchLanguageName(languages, name);
  }
  if (!desc) return [];
  try {
    return await desc.load();
  } catch {
    return [];
  }
}

export interface EditorOptions {
  doc: string;
  filename: string;
  dark: boolean;
  wrap: boolean;
  tabSize: number;
  readOnly?: boolean;
  onChange?: (doc: string) => void;
  onSave?: () => void;
  onSelection?: (sel: { from: number; to: number; text: string; fromLine: number; toLine: number } | null) => void;
}

// Compartimentos compartilhados: permitem guardar o EditorState de cada aba e restaurá-lo depois
// (mantém desfazer/refazer por arquivo) mesmo criando uma nova EditorView.
const langC = new Compartment();
const themeC = new Compartment();
const wrapC = new Compartment();
const roC = new Compartment();
const tabC = new Compartment();

export class CodeEditor {
  view: EditorView;
  private lang = langC;
  private theme = themeC;
  private wrap = wrapC;
  private ro = roC;
  private tab = tabC;

  constructor(parent: HTMLElement, o: EditorOptions, saved?: EditorState) {
    if (saved) {
      this.view = new EditorView({ parent, state: saved });
      this.setTheme(o.dark);
      this.setWrap(o.wrap);
      this.setReadOnly(!!o.readOnly);
      return;
    }
    const saveKey = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          o.onSave?.();
          return true;
        },
      },
    ]);
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: o.doc,
        extensions: [
          saveKey,
          lineNumbers(),
          foldGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true }),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          search({ top: true }),
          scrollPastEnd(),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          this.lang.of([]),
          this.theme.of([baseTheme(o.dark), syntaxHighlighting(o.dark ? darkColors : lightColors)]),
          this.wrap.of(o.wrap ? EditorView.lineWrapping : []),
          this.ro.of(EditorState.readOnly.of(!!o.readOnly)),
          this.tab.of([EditorState.tabSize.of(o.tabSize), indentUnit.of(' '.repeat(o.tabSize))]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) o.onChange?.(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) {
              const r = u.state.selection.main;
              if (r.empty) o.onSelection?.(null);
              else
                o.onSelection?.({
                  from: r.from,
                  to: r.to,
                  text: u.state.sliceDoc(r.from, r.to),
                  fromLine: u.state.doc.lineAt(r.from).number,
                  toLine: u.state.doc.lineAt(r.to).number,
                });
            }
          }),
        ],
      }),
    });
    languageFor(o.filename).then((ext) => this.view.dispatch({ effects: this.lang.reconfigure(ext) }));
  }

  setDoc(doc: string) {
    if (doc === this.view.state.doc.toString()) return;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: doc } });
  }

  setTheme(dark: boolean) {
    this.view.dispatch({ effects: this.theme.reconfigure([baseTheme(dark), syntaxHighlighting(dark ? darkColors : lightColors)]) });
  }

  setWrap(w: boolean) {
    this.view.dispatch({ effects: this.wrap.reconfigure(w ? EditorView.lineWrapping : []) });
  }

  setReadOnly(r: boolean) {
    this.view.dispatch({ effects: this.ro.reconfigure(EditorState.readOnly.of(r)) });
  }

  goToLine(line: number) {
    const l = Math.max(1, Math.min(line, this.view.state.doc.lines));
    const pos = this.view.state.doc.line(l).from;
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    this.view.focus();
  }

  get doc() {
    return this.view.state.doc.toString();
  }

  destroy() {
    this.view.destroy();
  }
}
