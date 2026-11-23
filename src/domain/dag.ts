import { SpriteNodeSchema, type SpriteNode } from './schemas';

export interface DagValidationResult {
  valid: boolean;
  reason?: string;
}

export interface DagTreeRow {
  node: SpriteNode;
  depth: number;
  isLeaf: boolean;
}

/**
 * Validates that a set of SpriteNodes has unique IDs, no self-parenting,
 * and contains zero directed cycles.
 */
export function validateDagAcyclicity(nodes: readonly SpriteNode[]): DagValidationResult {
  const byId = new Map<string, SpriteNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      return { valid: false, reason: `Duplicate node ID "${node.id}"` };
    }
    if (node.parentId === node.id) {
      return { valid: false, reason: `Self-parenting detected on node "${node.id}"` };
    }
    byId.set(node.id, node);
  }

  // 0 = unvisited, 1 = visiting (on active stack), 2 = verified acyclic
  const state = new Map<string, 0 | 1 | 2>();

  for (const node of nodes) {
    if (state.get(node.id) === 2) continue;
    let cursor: SpriteNode | undefined = node;
    const trail: string[] = [];

    while (cursor) {
      const currentState = state.get(cursor.id) ?? 0;
      if (currentState === 1) {
        return { valid: false, reason: `Cycle detected involving node "${cursor.id}"` };
      }
      if (currentState === 2) {
        break;
      }
      state.set(cursor.id, 1);
      trail.push(cursor.id);

      if (cursor.parentId === null) {
        cursor = undefined;
      } else {
        const parent = byId.get(cursor.parentId);
        if (!parent) {
          return {
            valid: false,
            reason: `Missing parent node "${cursor.parentId}" referenced by "${cursor.id}"`,
          };
        }
        cursor = parent;
      }
    }

    for (const id of trail) {
      state.set(id, 2);
    }
  }

  return { valid: true };
}

/**
 * Appends a validated child (or root) node while guaranteeing DAG acyclicity and valid parentage.
 */
export function appendChildNode(
  nodes: readonly SpriteNode[],
  candidateNode: SpriteNode,
): SpriteNode[] {
  const newNode = SpriteNodeSchema.parse(candidateNode);
  if (nodes.some((n) => n.id === newNode.id)) {
    throw new Error(`Node ID "${newNode.id}" already exists in DAG.`);
  }
  if (newNode.parentId === newNode.id) {
    throw new Error(`Node "${newNode.id}" cannot reference itself as parent.`);
  }
  if (newNode.parentId !== null && !nodes.some((n) => n.id === newNode.parentId)) {
    throw new Error(`Parent node "${newNode.parentId}" does not exist in DAG.`);
  }

  const next = [...nodes, newNode];
  const validation = validateDagAcyclicity(next);
  if (!validation.valid) {
    throw new Error(validation.reason ?? 'Invalid DAG transition.');
  }
  return next;
}

/**
 * Resolves a valid ancestor node to serve as parent for a forked branch.
 */
export function forkFromAncestor(nodes: readonly SpriteNode[], ancestorId: string): SpriteNode {
  const validation = validateDagAcyclicity(nodes);
  if (!validation.valid) {
    throw new Error(validation.reason ?? 'Cannot fork from invalid DAG.');
  }
  const ancestor = nodes.find((n) => n.id === ancestorId);
  if (!ancestor) {
    throw new Error(`Ancestor node "${ancestorId}" not found.`);
  }
  return ancestor;
}

/**
 * Computes the ordered ancestor path from the root node down to `nodeId`.
 */
export function getAncestorPath(nodes: readonly SpriteNode[], nodeId: string): SpriteNode[] {
  const byId = new Map<string, SpriteNode>(nodes.map((n) => [n.id, n]));
  const path: SpriteNode[] = [];
  const visited = new Set<string>();

  let currentId: string | null = nodeId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error(`Cycle detected while resolving ancestry for "${nodeId}".`);
    }
    visited.add(currentId);
    const found = byId.get(currentId);
    if (!found) {
      throw new Error(`Node "${currentId}" not found while resolving ancestry.`);
    }
    path.push(found);
    currentId = found.parentId;
  }

  return path.reverse();
}

/**
 * Lists direct children of `parentId` ordered deterministically by creation timestamp.
 */
export function getChildren(nodes: readonly SpriteNode[], parentId: string | null): SpriteNode[] {
  return nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.generationMeta.createdAt.localeCompare(b.generationMeta.createdAt));
}

/**
 * Safely deletes a leaf node without affecting any sibling branches or ancestors.
 * Throws if the node has child branches.
 */
export function deleteLeafNode(nodes: readonly SpriteNode[], nodeId: string): SpriteNode[] {
  const exists = nodes.some((n) => n.id === nodeId);
  if (!exists) {
    throw new Error(`Node "${nodeId}" not found in DAG.`);
  }
  const children = getChildren(nodes, nodeId);
  if (children.length > 0) {
    throw new Error(
      `Cannot delete node "${nodeId}" because it has ${children.length} child branch(es).`,
    );
  }
  return nodes.filter((n) => n.id !== nodeId);
}

/**
 * Flattens the DAG into pre-order DFS rows with depth and leaf metadata for UI rendering.
 */
export function buildDagTreeRows(nodes: readonly SpriteNode[]): DagTreeRow[] {
  const rows: DagTreeRow[] = [];
  const childrenMap = new Map<string | null, SpriteNode[]>();

  for (const node of nodes) {
    const list = childrenMap.get(node.parentId) ?? [];
    list.push(node);
    childrenMap.set(node.parentId, list);
  }

  for (const list of childrenMap.values()) {
    list.sort((a, b) => a.generationMeta.createdAt.localeCompare(b.generationMeta.createdAt));
  }

  const visited = new Set<string>();
  const visit = (node: SpriteNode, depth: number) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const children = childrenMap.get(node.id) ?? [];
    rows.push({
      node,
      depth,
      isLeaf: children.length === 0,
    });
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  const roots = childrenMap.get(null) ?? [];
  for (const root of roots) {
    visit(root, 0);
  }

  return rows;
}
