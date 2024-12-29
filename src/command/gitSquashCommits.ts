import * as vscode from 'vscode';
import { execCommand, log, selectGitWorkspace, getOutputChannel } from '../utils';

/** Git Commit Squash Tool */
export async function gitSquashCommits() {
    try {
        getOutputChannel().show();

        // Select workspace
        const workspacePath = await selectGitWorkspace('Select workspace to squash commits');
        if (!workspacePath) {
            return;
        }

        const commits = await getCommits(workspacePath);
        if (commits.length === 0) {
            throw new Error('No commits found');
        }

        // Create QuickPick
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = `Commit List (${workspacePath})`;
        quickPick.placeholder = 'Select commits to squash (multiple selection allowed)';
        quickPick.canSelectMany = true;

        // Set options
        quickPick.items = commits.map(commit => ({
            label: commit.message,
            description: commit.hash,
            detail: `${commit.author} committed on ${commit.date}`,
            commit
        }));

        // Show QuickPick
        quickPick.show();

        // Wait for user selection
        const selection = await new Promise<readonly vscode.QuickPickItem[]>(resolve => {
            quickPick.onDidAccept(() => {
                resolve(quickPick.selectedItems);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                resolve([]);
                quickPick.dispose();
            });
        });

        if (selection.length < 2) {
            if (selection.length === 1) {
                vscode.window.showErrorMessage('Please select at least two commits to squash');
            }
            return;
        }

        // Get selected commits
        const selectedCommits = selection
            .map(item => (item as any).commit)
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        await squashSelectedCommits(selectedCommits, workspacePath);
    } catch (error: any) {
        const errorMessage = `Failed to squash commits: ${error.message}`;
        log(errorMessage);
        console.error(error);
        vscode.window.showErrorMessage(errorMessage);
    }
}

/**
 * Get commit list
 */
async function getCommits(workspacePath: string): Promise<any[]> {
    try {
        // First try to get basic log information
        const testOutput = await execCommand('git', ['log', '-n', '1'], workspacePath);
        if (!testOutput) {
            return [];
        }

        // If basic command succeeds, get formatted output
        const output = await execCommand('git', [
            'log',
            '-n',
            '10',
            '--pretty="format:%h|%an|%ad|%s"',
            '--date="format:%Y-%m-%d %H:%M:%S"',
            '--no-merges'
        ], workspacePath);

        if (!output) {
            return [];
        }

        return output.split('\n')
            .filter(line => line.trim().length > 0)
            .map(line => {
                const [hash, author, date, ...messageParts] = line.split('|');
                return {
                    hash,
                    author,
                    date,
                    message: messageParts.join('|') // Prevent commit message from containing | character
                };
            });
    } catch (error: any) {
        log(`Failed to get Git log: ${error.message}`);
        vscode.window.showErrorMessage(`Failed to get Git log: ${error.message}`);
        return [];
    }
}

/**
 * Squash selected commits
 */
async function squashSelectedCommits(commits: any[], workspacePath: string) {
    if (commits.length < 2) {
        throw new Error('Please select at least two commits to squash');
    }

    // Get earliest commit
    const earliestCommit = commits[commits.length - 1].hash;

    // Get all commit messages
    const commitMessages = await Promise.all(commits.map(commit => getCommitMessage(commit.hash, workspacePath)));
    
    // Check if all messages are the same
    const allMessagesAreSame = commitMessages.every(msg => msg === commitMessages[0]);
    
    // Prepare new commit message
    let defaultMessage = allMessagesAreSame 
        ? commitMessages[0] 
        : commitMessages.join('\n\n');

    // Create temporary file to edit commit message
    const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse('untitled:commit-message.txt')
    );
    await vscode.window.showTextDocument(document);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), defaultMessage);
    await vscode.workspace.applyEdit(edit);
    
    // Wait for user to edit and confirm
    const editResult = await vscode.window.showInformationMessage(
        'Please edit the commit message in the editor, then click "OK" button.',
        'OK',
        'Cancel'
    );

    // Get content before closing editor
    const newMessage = editResult === 'OK' ? document.getText() : undefined;
    
    // Discard changes before closing editor
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

    if (!newMessage) {
        return;
    }

    log(`New commit message: ${newMessage}`);
    log(`Earliest commit: ${earliestCommit}`);

    try {
        // Soft reset to the commit before earliest
        await execCommand('git', ['reset', '--soft', `${earliestCommit}^`], workspacePath);
        
        // Create new commit
        await execCommand('git', ['commit', '-m', newMessage], workspacePath);
        
        vscode.window.showInformationMessage('Commits squashed successfully!');
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to squash commits: ${error.message}`);
        throw error;
    }
}

/**
 * Get commit message
 */
async function getCommitMessage(hash: string, workspacePath: string): Promise<string> {
    const output = await execCommand('git', ['log', '-1', '--pretty=%B', hash], workspacePath);
    return output.trim();
} 