import {
  Disposable,
  ExtensionContext,
  TextEditor,
  ViewColumn,
  Webview,
  WebviewPanel,
  WebviewPanelOnDidChangeViewStateEvent,
  Uri,
  commands,
  window,
  workspace,
} from 'vscode';

import * as shiki from 'shiki';
import { readFileSync } from 'node:fs';
import * as path from 'path';

import {
  CompilationResult,
  debounce,
  getResourceUri,
  normalizeThemeName,
} from './utils';

import { ViewContext } from './viewContext';
import { isPrqlDocument } from '../utils';
import { compile } from '../compiler';
import * as constants from '../constants';

/**
 * Defines Sql Preview class for managing state and behaviour of Sql Preview webview panel(s).
 */
export class SqlPreview {

  // view tracking vars
  public static currentView: SqlPreview | undefined;
  private static _views: Map<string, SqlPreview> = new Map<string, SqlPreview>();

  // view instance vars
  private readonly _webviewPanel: WebviewPanel;
  private readonly _extensionUri: Uri;
  private readonly _documentUri: Uri;
  private readonly _viewUri: Uri;
  private _viewConfig: any = {};
  private _disposables: Disposable[] = [];

  private _highlighter: shiki.Highlighter | undefined;
  private _lastEditor: TextEditor | undefined = undefined;
  private _lastSqlHtml: string | undefined;

  /**
     * Reveals current Sql Preview webview
     * or creates new Sql Preview webview panel
     * for the given PRQL document Uri
     * from an open and active PRQL document editor.
     *
     * @param context Extension context.
     * @param documentUri PRQL document Uri.
     * @param webviewPanel Optional webview panel instance.
     * @param viewConfig View config to restore.
     */
  public static render(context: ExtensionContext, documentUri: Uri,
    webviewPanel?: WebviewPanel, viewConfig?: any) {

    // create view Uri
    const viewUri: Uri = documentUri.with({ scheme: 'prql' });

    // check for open sql preview
    const sqlPreview: SqlPreview | undefined = SqlPreview._views.get(viewUri.toString(true)); // skip encoding
    if (sqlPreview) {
      // show loaded webview panel in the active editor view column
      sqlPreview.reveal();
      SqlPreview.currentView = sqlPreview;
    }
    else {
      if (!webviewPanel) {
        // create new webview panel for the prql document sql preview
        webviewPanel = SqlPreview.createWebviewPanel(context, documentUri);
      }
      else {
        // enable scripts for existing webview panel
        webviewPanel.webview.options = {
          enableScripts: true,
          enableCommandUris: true
        };
      }

      if (webviewPanel) {
        // set custom sql preview panel icon
        webviewPanel.iconPath = Uri.file(
          path.join(context.extensionUri.fsPath, './resources/favicon.ico'));
      }

      // set as current sql preview
      SqlPreview.currentView = new SqlPreview(context, webviewPanel, documentUri, viewConfig);
    }

    // update sql preview context values
    commands.executeCommand('setContext', ViewContext.SqlPreviewActive, true);
    commands.executeCommand('setContext', ViewContext.LastActivePrqlDocumentUri, documentUri);
  }

  /**
   * Creates new webview panel for the given prql source document Uri.
   *
   * @param context Extension context.
   * @param documentUri PRQL source document Uri.
   * @returns New webview panel instance.
   */
  private static createWebviewPanel(context: ExtensionContext, documentUri: Uri): WebviewPanel {
    // create new webview panel for sql preview
    const fileName = path.basename(documentUri.path, '.prql');
    return window.createWebviewPanel(
      constants.SqlPreviewPanel, // webview panel view type
      `${constants.SqlPreviewTitle}: ${fileName}.sql`, // webview panel title
      {
        viewColumn: ViewColumn.Beside, // display it on the side
        preserveFocus: true
      },
      { // webview panel options
        enableScripts: true, // enable JavaScript in webview
        enableCommandUris: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [Uri.joinPath(context.extensionUri, 'resources')],
      }
    );
  }

  /**
   * Creates new SqlPreivew webview panel instance.
   *
   * @param context Extension context.
   * @param webviewPanel Reference to the webview panel.
   * @param documentUri PRQL document Uri.
   * @param viewConfig Optional view config to restore.
   */
  private constructor(context: ExtensionContext,
    webviewPanel: WebviewPanel,
    documentUri: Uri, viewConfig?: any) {

    // save view context info
    this._webviewPanel = webviewPanel;
    this._extensionUri = context.extensionUri;
    this._documentUri = documentUri;
    this._viewUri = documentUri.with({ scheme: 'prql' });

    if (viewConfig) {
      // save view config to restore
      this._viewConfig = viewConfig;
    }

    // configure webview panel
    this.configure(context);

    // add it to the tracked sql preview webviews
    SqlPreview._views.set(this._viewUri.toString(true), this);

    // update view context values on webview state change
    this._webviewPanel.onDidChangeViewState(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (viewChangeEvent: WebviewPanelOnDidChangeViewStateEvent) => {
        if (this._webviewPanel.active) {
          // update view context values
          commands.executeCommand('setContext', ViewContext.SqlPreviewActive, true);
          commands.executeCommand('setContext', ViewContext.LastActivePrqlDocumentUri, documentUri);
          SqlPreview.currentView = this;
        }
        else {
          // clear sql preview context
          commands.executeCommand('etContext', ViewContext.SqlPreviewActive, false);
          SqlPreview.currentView = undefined;
        }
      });

    // add prql text document change handler
    [workspace.onDidOpenTextDocument, workspace.onDidChangeTextDocument].forEach(
      (event) => {
        this._disposables.push(
          event(
            debounce(() => {
              this.sendText(context, this._webviewPanel);
            }, 10)
          )
        );
      }
    );

    // add active text editor change handler
    this._disposables.push(
      window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor !== this._lastEditor) {
          this._lastEditor = editor;
          this._lastSqlHtml = undefined;
          this.clearSqlContext(context);
          this.sendText(context, this._webviewPanel);
        }
      })
    );

    // add color theme change handler
    this._disposables.push(
      window.onDidChangeActiveColorTheme(() => {
        this._highlighter = undefined;
        this._lastSqlHtml = undefined;
        this.sendThemeChanged(this._webviewPanel);
      })
    );

    // add dispose resources handler
    this._webviewPanel.onDidDispose(() => this.dispose(context));
  }

  /**
    * Disposes Sql Preview webview resources when webview panel is closed.
    */
  public dispose(context: ExtensionContext) {
    SqlPreview.currentView = undefined;
    SqlPreview._views.delete(this._viewUri.toString(true)); // skip encoding
    this._disposables.forEach((d) => d.dispose());

    // clear active view context value
    this.clearSqlContext(context);
    commands.executeCommand('setContext', ViewContext.SqlPreviewActive, false);
  }

  /**
    * Reveals loaded Sql Preview and sets it as active in vscode editor panel.
    */
  public reveal() {
    const viewColumn: ViewColumn = ViewColumn.Active ? ViewColumn.Active : ViewColumn.One;
    this.webviewPanel.reveal(viewColumn);

    // update table view context values
    commands.executeCommand('setContext', ViewContext.SqlPreviewActive, true);
    commands.executeCommand('setContext', ViewContext.LastActivePrqlDocumentUri, this.documentUri);
  }

  /**
     * Configures webview html for the Sql Preview display,
     * and registers webview message request handlers for updates.
     *
     * @param context Extension context.
     * @param viewConfig Sql Preview config.
     */
  private configure(context: ExtensionContext): void {
    // set view html content for the webview panel
    this.webviewPanel.webview.html = this.getCompiledTemplate(context, this.webviewPanel.webview);
    // this.getWebviewContent(this.webviewPanel.webview, this._extensionUri, viewConfig);

    // process webview messages
    this.webviewPanel.webview.onDidReceiveMessage((message: any) => {
      const command: string = message.command;
      switch (command) {
        case 'refresh':
          // reload data view and config
          this.refresh();
          break;
      }
    }, undefined, this._disposables);

    this.sendText(context, this._webviewPanel);
  }

  /**
    * Reloads Sql Preivew for the PRQL document Uri or on vscode IDE realod.
    */
  public async refresh(): Promise<void> {
    // update view state
    this.webviewPanel.webview.postMessage({
      command: 'refresh',
      documentUrl: this.documentUri.fsPath
    });
  }

  private sendText(context: ExtensionContext, panel: WebviewPanel) {
    const editor = window.activeTextEditor;

    if (panel.visible && editor && isPrqlDocument(editor)) {
      const text = editor.document.getText();
      this.compilePrql(text, this._lastSqlHtml).then((result) => {
        if (result.status === 'ok') {
          this._lastSqlHtml = result.html;
        }
        panel.webview.postMessage(result);

        // set sql preview flag and update sql output
        commands.executeCommand('setContext', ViewContext.SqlPreviewActive, true);
        commands.executeCommand('setContext',
          ViewContext.LastActivePrqlDocumentUri, editor.document.uri);
        context.workspaceState.update('prql.sql', result.sql);
      });
    }

    if (!panel.visible || !panel.active) {
      this.clearSqlContext(context);
    }
  }

  private async sendThemeChanged(panel: WebviewPanel) {
    panel.webview.postMessage({ status: 'theme-changed' });
  }

  private async compilePrql(text: string,
    lastOkHtml: string | undefined): Promise<CompilationResult> {
    const result = compile(text);

    if (Array.isArray(result)) {
      return {
        status: 'error',
        error: {
          message: result[0].display ?? result[0].reason,
        },
        lastHtml: lastOkHtml,
      };
    }

    const highlighter = await this.getHighlighter();
    const highlighted = highlighter.codeToHtml(result, { lang: 'sql' });

    return {
      status: 'ok',
      html: highlighted,
      sql: result,
    };
  }

  /**
   * Clears active SQL Preview context and view state.
   *
   * @param context Extension context.
   */
  private async clearSqlContext(context: ExtensionContext) {
    commands.executeCommand('setContext', ViewContext.SqlPreviewActive, false);
    context.workspaceState.update('prql.sql', undefined);
  }

  private async getHighlighter(): Promise<shiki.Highlighter> {
    if (this._highlighter) {
      return Promise.resolve(this._highlighter);
    }
    return (this._highlighter = await shiki.getHighlighter({theme: this.themeName}));
  }

  get themeName(): string {
    const currentThemeName = workspace.getConfiguration('workbench')
      .get<string>('colorTheme', 'dark-plus');

    for (const themeName of [currentThemeName, normalizeThemeName(currentThemeName)]) {
      if (shiki.BUNDLED_THEMES.includes(themeName as shiki.Theme)) {
        return themeName;
      }
    }

    return 'css-variables';
  }

  /**
   * Gets the underlying webview panel instance for this view.
   */
  get webviewPanel(): WebviewPanel {
    return this._webviewPanel;
  }

  /**
   * Gets view panel visibility status.
   */
  get visible(): boolean {
    return this._webviewPanel.visible;
  }


  /**
   * Gets the source data uri for this view.
   */
  get documentUri(): Uri {
    return this._documentUri;
  }

  /**
   * Gets the view uri to load on tabular data view command triggers or vscode IDE reload.
   */
  get viewUri(): Uri {
    return this._viewUri;
  }


  private getCompiledTemplate(context: ExtensionContext, webview: Webview): string {
    // load webview html template, sql preview script and stylesheet
    const htmlTemplate = readFileSync(
      getResourceUri(context, 'sql-preview.html').fsPath, 'utf-8');
    const sqlPreviewScriptUri: Uri = getResourceUri(context, 'sqlPreview.js');
    const sqlPreviewStylesheetUri: Uri = getResourceUri(context, 'sql-preview.css');

    // inject web resource urls into the loaded webview html template
    return htmlTemplate.replace(/##CSP_SOURCE##/g, webview.cspSource)
      .replace('##JS_URI##', webview.asWebviewUri(sqlPreviewScriptUri).toString())
      .replace('##CSS_URI##', webview.asWebviewUri(sqlPreviewStylesheetUri).toString());
  }
}