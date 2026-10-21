export interface PanelBounds { x: number; y: number; width: number; height: number; }
export type PanelTarget = { type: 'url'; url: string } | { type: 'file'; path: string };
export interface NodePanel {
  id: string; projectId: string; nodeId: string; kind: 'browser' | 'file'; title: string;
  url?: string; path?: string; loading: boolean; error?: string; canGoBack: boolean; canGoForward: boolean;
}
export interface PanelSnapshot { projectId: string; nodeId: string; panels: NodePanel[]; activePanelId: string | null; }
type PanelScope = { projectId: string; nodeId: string };
export type PanelCommand = PanelScope & (
  | { type: 'list' }
  | { type: 'open'; target: PanelTarget; title?: string }
  | { type: 'activate' | 'close'; panelId: string }
  | { type: 'navigate'; panelId: string; action?: 'back' | 'forward' | 'reload'; url?: string }
  | { type: 'layout'; bounds: PanelBounds | null }
);
