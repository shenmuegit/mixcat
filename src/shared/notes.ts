export interface Note {
  id: string;
  title: string;
  body: string;
  parentId: string | null;
  order: number;
  relatedIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string; // Legacy snapshots can contain soft-deleted notes.
}

export interface NotesSnapshot { revision: number; notes: Note[]; }
export interface NoteMutation {
  request_id: string;
  operation: 'create' | 'edit' | 'move' | 'associate' | 'delete';
  expected_revision: number;
  id?: string;
  title?: string;
  body?: string;
  parentId?: string | null;
  beforeId?: string | null;
  targetId?: string;
  linked?: boolean;
}
