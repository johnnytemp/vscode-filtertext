import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as process from 'process';
import * as os from 'os';
import * as glob from 'glob';
import * as which from 'which';
import * as shell_quote from 'shell-quote';

let lastEntry: string = '';

export function activate(context: vscode.ExtensionContext) {
    let inplace = vscode.commands.registerCommand('extension.filterTextInplace', () => filterText(true));
    let tofile = vscode.commands.registerCommand('extension.filterText', () => filterText(false));

    context.subscriptions.push(inplace);
    context.subscriptions.push(tofile);
}

async function filterText(inplace: boolean) {
    vscode.window.showInputBox({
        placeHolder: 'Please enter command name and arguments.',
        value: lastEntry
    }).then(async (entry: string) => {
        if (entry) {
            const cwd = getCurrentWorkingDirectory();

            const commands = shell_quote.parse(entry).reduce((r, v) => {
                if (v.op === '|') {
                    return r.concat([[]]);
                } if (v.op === 'glob') {
                    const items = glob.sync(v.pattern, { cwd });
                    r[r.length - 1] = r[r.length - 1].concat(items);
                    return r;
                } else {
                    r[r.length - 1].push(v);
                    return r;
                }
            }, [[]]);

            if (!commands.length) {
              return;
            }

            lastEntry = entry; // save even if not a valid command to make it easier to fix a typo

            const range = getSelectionRange();
            let text = getTextFromRange(range);

            for (const args of commands) {
              if (!args.length) {
                  return;
              }

              try {
                  const name = args.shift();
                  text = await executeCommand(name, args, text, { cwd });
              } catch(err) {
                  vscode.window.showErrorMessage(err);
                  return;
              }
            }

            setTextToSelectionRange(inplace, range, text);
        }
    });
}

function getSelectionRange(): vscode.Selection {
    let config = (vscode.workspace.getConfiguration('filterText') as any);
    let useDocument = config.useDocumentIfEmptySelection;

    let editor = vscode.window.activeTextEditor;

    let range = undefined;
    if (!editor.selection.isEmpty) {
        range = editor.selection;
    }

    if (range === undefined && editor.document.lineCount > 0 && useDocument === true) {
        let lineCount = editor.document.lineCount;
        range = new vscode.Range(0, 0, lineCount, editor.document.lineAt(lineCount-1).text.length);
    }

    return range;
}

function getTextFromRange(range: vscode.Selection): string {
    if (range !== undefined) {
        let editor = vscode.window.activeTextEditor;
        return editor.document.getText(range);
    }
    return '';
}

function setTextToSelectionRange(inplace: boolean, range: vscode.Selection, text: string): void {
    let target = inplace ? Promise.resolve(vscode.window.activeTextEditor) : getTempEditor(text);
    target.then((editor) => {
        editor.edit((editBuilder) => {
            if (inplace) {
                editBuilder.replace(range, text);
            }
        });
        editor.revealRange(range);
    }, (reason: Error) => {
        vscode.window.showErrorMessage(reason.message);
    });
}

function executeCommand(name: string, args: string[], inputText: string, options: object): Promise<string> {
    let cwd = options['cwd'];
    let config = (vscode.workspace.getConfiguration('filterText') as any);
    let platform = os.platform();
    let bashPath = null;
    if (platform === 'win32' && config.invokeViaBash.windows === true) {
        bashPath = config.bashPath.windows; // config.bashPath.windows default to "C:/cygwin/bin/bash.exe"
    }
    return new Promise((resolve, reject) => {
        let run = (path, args, resolve) => {
            let filter = child_process.spawn(path, args, options);

            if (inputText.length > 0) {
                filter.stdin.write(inputText);
            }
            filter.stdin.end();

            let filteredText = '';
            let errorText = '';
            filter.stdout.on('data', function (data) {
                filteredText += data;
            });

            filter.stderr.on('data', function (data) {
                errorText += data;
            });
            filter.on('close', function (code: number, signal: string) {
                if (filteredText == '' && code != 0 && errorText != '') { // Only reject and show error when stdout got nothing, exit status indicate failure, and stderr got something.  E.g. grep with no match will have failure status, but no error message or output, shouldn't show error here.
                    reject("Command exits (status: " + code + ") with error message:\n" + errorText);
                } else {
                    resolve(filteredText);
                }
            });
        };
        if (bashPath === null) {
            let originalDir = process.cwd();
            process.chdir(cwd || '');
            which(name, (err, path) => {
                process.chdir(originalDir);
                if (err) {
                    reject('Invalid command is entered.');
                    return;
                }
                run(path, args, resolve);
            });
        } else {
            let prependArgs;
            // invoke bash with "-l" (--login) option.  This is needed for Cygwin where the Cygwin's C:/cygwin/bin path may exist in PATH only after --login.
            if (cwd != null)
                prependArgs = ['-lc', 'cd "$1"; shift; "$@"', 'bash', cwd, name]; // set current working directory after bash's --login (-l)
            else
                prependArgs = ['-lc', '"$@"', 'bash', name]; // 'bash' at "$0" is the program name for stderr messages' labels.
            run(bashPath, prependArgs.concat(args), resolve);
        }
    });
}

function getTempEditor(content: string): PromiseLike<vscode.TextEditor> {
    return new Promise((resolve, reject) => {
        vscode.workspace.openTextDocument({content: content, language: "" } as any).then(
            (doc) => {
                resolve(vscode.window.showTextDocument(doc));
            },
            (err) => reject(err)
        );
    });
}

function getCurrentWorkingDirectory(): string {
    const uri = vscode.window.activeTextEditor.document.uri;

    if (uri && uri.scheme === 'file') {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (folder) {
            return folder.uri.fsPath;
        }

        try {
          const folders = vscode.workspace.workspaceFolders;
          if (folders.length > 0) {
              return folders[0].uri.fsPath;
          }
        } catch(err) {
        }
    }

    return os.homedir();
}
