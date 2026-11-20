import { useMemo, useState } from 'react';
import type { TodoItem } from '../mode/types';

const STATUS_ICON: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
};

/**
 * 任务清单面板：展示 todo_write 工具产出的清单。
 * 分组可折叠、条目按状态显示图标；清单内容由模型维护，这里只做只读渲染。
 */
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [panelOpen, setPanelOpen] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );

  const groups = useMemo(() => {
    const map = new Map<string, TodoItem[]>();
    for (const item of todos) {
      const key = item.group || '任务';
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [todos]);

  const done = todos.filter((t) => t.status === 'completed').length;

  const toggleGroup = (name: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="todo-panel">
      <button
        type="button"
        className="todo-head"
        onClick={() => setPanelOpen((v) => !v)}
      >
        <span className={`todo-chevron${panelOpen ? ' open' : ''}`}>›</span>
        <span className="todo-title">任务清单</span>
        <span className="todo-count">
          {done}/{todos.length}
        </span>
      </button>
      {panelOpen ? (
        <div className="todo-groups">
          {groups.map(([name, items]) => {
            const groupDone = items.filter(
              (t) => t.status === 'completed',
            ).length;
            const collapsed = collapsedGroups.has(name);
            return (
              <div key={name} className="todo-group">
                <button
                  type="button"
                  className="todo-group-head"
                  onClick={() => toggleGroup(name)}
                >
                  <span
                    className={`todo-chevron${collapsed ? '' : ' open'}`}
                  >
                    ›
                  </span>
                  <span className="todo-group-name">{name}</span>
                  <span className="todo-group-count">
                    {groupDone}/{items.length}
                  </span>
                </button>
                {collapsed ? null : (
                  <ul className="todo-list">
                    {items.map((item, i) => (
                      <li
                        key={`${item.content}-${i}`}
                        className={`todo-item status-${item.status}`}
                      >
                        <span className={`todo-icon icon-${item.status}`}>
                          {STATUS_ICON[item.status]}
                        </span>
                        <span className="todo-text">{item.content}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
