import { Task, TaskGraph } from '../config/task-graph';
import { getCustomHasher } from '../tasks-runner/utils';
import { readProjectsConfigurationFromProjectGraph } from '../project-graph/project-graph';
import { Hasher } from './hasher';
import { ProjectGraph } from '../config/project-graph';
import { Workspaces } from '../config/workspaces';

export function hashDependsOnOtherTasks(
  workspaces: Workspaces,
  hasher: Hasher,
  projectGraph: ProjectGraph,
  taskGraph: TaskGraph,
  task: Task
) {
  const customHasher = getCustomHasher(
    task,
    workspaces,
    workspaces.readNxJson(),
    projectGraph
  );
  if (customHasher) return true;
  return hasher.hashDependsOnOtherTasks(task);
}

export async function hashTask(
  workspaces: Workspaces,
  hasher: Hasher,
  projectGraph: ProjectGraph,
  taskGraph: TaskGraph,
  task: Task
) {
  const customHasher = getCustomHasher(
    task,
    workspaces,
    workspaces.readNxJson(),
    projectGraph
  );
  const { value, details } = await (customHasher
    ? customHasher(task, {
        hasher,
        projectGraph,
        taskGraph,
        workspaceConfig:
          readProjectsConfigurationFromProjectGraph(projectGraph),
      })
    : hasher.hashTask(task));
  task.hash = value;
  task.hashDetails = details;
}
