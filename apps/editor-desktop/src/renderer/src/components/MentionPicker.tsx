export function MentionPicker({
  results,
  active,
  onSelect,
  onHover,
}: {
  results: string[];
  active: number;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="mention-picker">
      {results.map((path, i) => (
        <button
          key={path}
          type="button"
          className={i === active ? 'active' : ''}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(path);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {path}
        </button>
      ))}
      {!results.length ? (
        <div className="muted small mention-empty">没有匹配的文件</div>
      ) : null}
    </div>
  );
}
