// Queue-only comparison: native output previews can resize nodes while a batch is being admitted.
export function queueComparison(workflow) {
  const project = graph => ({
    ...graph,
    ...(Array.isArray(graph.nodes) ? { nodes: graph.nodes.map(node => {
      const { size, ...value } = node;
      if (value.widgets_values == null || Array.isArray(value.widgets_values) && value.widgets_values.length === 0) delete value.widgets_values;
      if (value.widgets_values_named && typeof value.widgets_values_named === 'object' && !Array.isArray(value.widgets_values_named) && Object.keys(value.widgets_values_named).length === 0) delete value.widgets_values_named;
      return value;
    }) } : {}),
    ...(Array.isArray(graph.definitions?.subgraphs) ? { definitions: { ...graph.definitions, subgraphs: graph.definitions.subgraphs.map(project) } } : {})
  });
  return JSON.stringify(project(workflow));
}
