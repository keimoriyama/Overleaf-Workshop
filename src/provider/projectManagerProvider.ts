import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { GlobalStateManager, ProjectPersist } from '../utils/globalStateManager';
import { ProjectTagsResponseSchema } from '../api/base';

class DataItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(label, collapsibleState);
    }
}

class ServerItem extends DataItem {
    tags?: {name:string, id:string}[];
    constructor(
        readonly api: any,
        public readonly name: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(name, collapsibleState);
        this.iconPath = new vscode.ThemeIcon('vm');
        this.contextValue = collapsibleState===vscode.TreeItemCollapsibleState.None ? 'server_no_login' : 'server_login';
    }
}

class TagItem extends DataItem {
    constructor(
        readonly api: any,
        public readonly serverName: string,
        public readonly id: string,
        public readonly name: string,
        readonly projects: ProjectItem[],
    ) {
        super(name, vscode.TreeItemCollapsibleState.Collapsed);
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'tag';
    }
}

class ProjectItem extends DataItem {
    tag?: {name:string, id:string};
    constructor(
        readonly api: any,
        public uri: string,
        readonly parent: ServerItem,
        readonly id: string,
        readonly label: string,
        status: 'normal' | 'archived' | 'trashed',
    ) {
        const _label = status==='normal' ? label : `[${status}] ${label}`;
        super(_label, vscode.TreeItemCollapsibleState.None);
        this.uri = uri;
        this.setStatus(status);
    }

    setStatus(status:'normal' | 'archived' | 'trashed') {
        switch (status) {
            case 'normal':
                this.contextValue = 'project';
                this.iconPath = new vscode.ThemeIcon('notebook');
                break;
            case 'archived':
                this.contextValue = 'archived_project';
                this.iconPath = new vscode.ThemeIcon('archive');
                break;
            case 'trashed':
                this.contextValue = 'trashed_project';
                this.iconPath = new vscode.ThemeIcon('trash');
        }
    }
}

export class ProjectManagerProvider implements vscode.TreeDataProvider<DataItem> {
    constructor(
        private context:vscode.ExtensionContext) {
        this.context = context;
    }

    private _onDidChangeTreeData: vscode.EventEmitter<DataItem | undefined | void> = new vscode.EventEmitter<DataItem | undefined | void>();

    readonly onDidChangeTreeData: vscode.Event<DataItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DataItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DataItem): Thenable<DataItem[]> {
        if (element) {
            if (element instanceof ServerItem) {
                return GlobalStateManager.fetchServerProjects(this.context, element.api, element.name)
                .then(projects => {
                    return GlobalStateManager.authenticate(this.context, element.name)
                    .then(identity => element.api.getAllTags(identity))
                    .then(res => 
                        res.type==='success' ? res.tags as ProjectTagsResponseSchema[] : []
                    )
                    .then(tags => {
                        return {projects, tags};
                    });
                })
                .then(({projects, tags}) => {
                    const allTags:{name:string, id:string}[] = [];
                    // get project items
                    const projectItems = projects.map(project => {
                        const uri = `${ROOT_NAME}://${element.name}/${project.name}?user=${project.userId}&project=${project.id}`;
                        const status = project.archived ? 'archived' : project.trashed ? 'trashed' : 'normal';
                        return new ProjectItem(element.api, uri, element, project.id, project.name, status);
                    });
                    // get tag items
                    const tagItems:TagItem[] = tags.map(tag => {
                        const _tag = {name:tag.name, id:tag._id};
                        allTags.push( _tag );
                        const _projectItems:ProjectItem[] = tag.project_ids.map(id => {
                            const index = projectItems.findIndex(project => project.id===id);
                            const item = projectItems.splice(index, 1)[0];
                            item.contextValue = 'project_in_tag';
                            item.tag = _tag;
                            return item;
                        });
                        return new TagItem(element.api, element.name, tag._id, tag.name, _projectItems);
                    });
                    // return all items
                    element.tags = allTags;
                    return [...tagItems, ...projectItems];
                });
            } else if (element instanceof TagItem) {
                return Promise.resolve(element.projects);
            } else {
                return Promise.resolve([]);
            }
        } else {
            const persists = GlobalStateManager.getServers(this.context);
            const serverItems = Object.values(persists).map(persist => new ServerItem(
                persist.api,
                persist.server.name,
                persist.server.login? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            ));
            return Promise.resolve(serverItems);
        }
    }

    addServer() {
        vscode.window.showInputBox({'placeHolder': 'Overleaf server address, e.g. "http://localhost:8080"'})
        .then((url) => {
            if (url) {
                try {
                    // check if url is valid
                    const _url = new URL(url);
                    if (!(_url.protocol==='http:' || _url.protocol==='https:')) {
                        throw new Error('Invalid protocol.');
                    }
                    if (GlobalStateManager.addServer(this.context, _url.host, _url.href)) {
                        this.refresh();
                    }
                } catch (e) {
                    vscode.window.showErrorMessage('Invalid server address.');
                }
            }
        });
    }

    removeServer(name:string) {
        vscode.window.showInformationMessage(`Remove server "${name}" ?`, "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                if (GlobalStateManager.removeServer(this.context, name)) {
                    this.refresh();
                }
            }
        });
    }

    loginServer(server: ServerItem) {
        const loginMethods = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login with Password': () => {
                vscode.window.showInputBox({'placeHolder': 'Email'})
                .then(email => email ? Promise.resolve(email) : Promise.reject())
                .then(email =>
                    vscode.window.showInputBox({'placeHolder': 'Password', 'password': true})
                    .then(password => {
                        return password ? Promise.resolve([email,password]) : Promise.reject();
                    })
                )
                .then(([email,password]) =>
                    GlobalStateManager.loginServer(this.context, server.api, server.name, {email, password})
                )
                .then(success => {
                    if (success) {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage('Login failed.');
                    }
                });
            },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login with Cookies': () => {
                vscode.window.showInputBox({'placeHolder': 'Cookies, e.g., "sharelatex.sid=..." or "overleaf_session2=..."',})
                .then(cookies => cookies ? Promise.resolve(cookies) : Promise.reject())
                .then(cookies =>
                    GlobalStateManager.loginServer(this.context, server.api, server.name, {cookies})
                )
                .then(success => {
                    if (success) {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage('Login failed.');
                    }
                });
            },
        };

        vscode.window.showQuickPick(Object.keys(loginMethods), {
            canPickMany:false, placeHolder:'Select the login method below.'})
        .then(selection => {
            if (selection===undefined) { return Promise.reject(); }
            return Promise.resolve( (loginMethods as any)[selection] );
        })
        .then(method => method());
    }

    logoutServer(server: ServerItem) {
        vscode.window.showInformationMessage(`Logout server "${server.name}" ?`, "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.logoutServer(this.context, server.api, server.name)
                .then(success => {
                    if (success) {
                        this.refresh();
                    }
                });
            }
        });
    }

    refreshServer(server: ServerItem) {
        this.refresh();
    }

    newProject(server: ServerItem) {
        // 'Blank Project', 'Example Project', 'Upload Project'
        vscode.window.showQuickPick(['Blank Project', 'Example Project', 'Upload Project'])
        .then((answer) => {
            switch (answer) {
                case 'Blank Project':
                case 'Example Project':
                    const template = answer==='Example Project' ? 'example' : 'none';
                    vscode.window.showInputBox({'placeHolder': 'Project name'})
                    .then(name => {
                        if (name) {
                            GlobalStateManager.authenticate(this.context, server.name)
                            .then(identity => server.api.newProject(identity, name, template))
                            .then(res => {
                                if (res.type==='success') {
                                    this.refresh();
                                } else {
                                    vscode.window.showErrorMessage(res.message);
                                }
                            });
                        }
                    });
                    break;
                case 'Upload Project':
                    break;
            }
        });
    }

    renameProject(project: ProjectItem) {
        vscode.window.showInputBox({
            'placeHolder': 'New project name',
            'value': project.label,
        })
        .then(newName => {
            if (newName && newName!==project.label) {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.renameProject(identity, project.id, newName))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    deleteProject(project: ProjectItem) {
        vscode.window.showInformationMessage(`Permanently delete project "${project.label}" ?`, "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.deleteProject(identity, project.id))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    archiveProject(project: ProjectItem) {
        vscode.window.showInformationMessage(`Archive project "${project.label}" ?`, "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.archiveProject(identity, project.id))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    unarchiveProject(project: ProjectItem) {
        GlobalStateManager.authenticate(this.context, project.parent.name)
        .then(identity => project.api.unarchiveProject(identity, project.id))
        .then(res => {
            if (res.type==='success') {
                this.refresh();
            } else {
                vscode.window.showErrorMessage(res.message);
            }
        });
    }

    trashProject(project: ProjectItem) {
        vscode.window.showInformationMessage(`Move project "${project.label}" to trash ?`, "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.trashProject(identity, project.id))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    untrashProject(project: ProjectItem) {
        GlobalStateManager.authenticate(this.context, project.parent.name)
        .then(identity => project.api.untrashProject(identity, project.id))
        .then(res => {
            if (res.type==='success') {
                this.refresh();
            } else {
                vscode.window.showErrorMessage(res.message);
            }
        });
    }

    createTag(server: ServerItem) {
        vscode.window.showInputBox({'placeHolder': 'Tag name'})
        .then(name => {
            if (name) {
                GlobalStateManager.authenticate(this.context, server.name)
                .then(identity => server.api.createTag(identity, name))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    renameTag(tag: TagItem) {
        vscode.window.showInputBox({
            'placeHolder': 'New tag name',
            'value': tag.label,
        })
        .then(newName => {
            if (newName && newName!==tag.label) {
                GlobalStateManager.authenticate(this.context, tag.serverName)
                .then(identity => tag.api.renameTag(identity, tag.id, newName))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    deleteTag(tag: TagItem) {
        vscode.window.showInformationMessage(`Delete tag "${tag.label}" ?`, "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, tag.serverName)
                .then(identity => tag.api.deleteTag(identity, tag.id))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    addProjectToTag(project: ProjectItem) {
        const tagNames = project.parent.tags?.map(tag => tag.name) || [];
        vscode.window.showQuickPick(tagNames, {
            canPickMany:false, placeHolder:'Select the tag below.'})
        .then(selection => {
            if (selection===undefined) { return Promise.reject(); }
            return Promise.resolve(selection);
        })
        .then(tagName => {
            const tagId = project.parent.tags?.find(tag => tag.name===tagName)?.id;
            GlobalStateManager.authenticate(this.context, project.parent.name)
            .then(identity => project.api.addProjectToTag(identity, tagId, project.id))
            .then(res => {
                if (res.type==='success') {
                    this.refresh();
                } else {
                    vscode.window.showErrorMessage(res.message);
                }
            });
        });
    }

    removeProjectFromTag(project: ProjectItem) {
        vscode.window.showInformationMessage(`Remove project "${project.label}" from tag "${project.tag?.name}" ?`, "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                GlobalStateManager.authenticate(this.context, project.parent.name)
                .then(identity => project.api.removeProjectFromTag(identity, project.tag?.id, project.id))
                .then(res => {
                    if (res.type==='success') {
                        this.refresh();
                    } else {
                        vscode.window.showErrorMessage(res.message);
                    }
                });
            }
        });
    }

    openProjectInCurrentWindow(project: ProjectItem) {
        const uri = vscode.Uri.parse(project.uri);
        vscode.commands.executeCommand('remoteFileSystem.prefetch', uri)
        .then(() => {
            vscode.commands.executeCommand('vscode.openFolder', uri, false);
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }

    openProjectInNewWindow(project: ProjectItem) {
        const uri = vscode.Uri.parse(project.uri);
        vscode.commands.executeCommand('remoteFileSystem.prefetch', uri)
        .then(() => {
            vscode.commands.executeCommand('vscode.openFolder', uri, true);
            vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            vscode.commands.executeCommand('workbench.view.explorer');
        });
    }
}
