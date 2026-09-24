import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface DemoItemOption {
  id: string;
  name: string;
  item_type: 'connection' | 'bookmark';
  protocol: string | null;
}

interface Props {
  apiBase: string;
  authToken: string;
  onSelect: (item: DemoItemOption) => void;
  placeholder?: string;
}

/**
 * Typeahead over GET /api/demos/searchable-items — the exact same
 * debounced-search-and-pick structure as UserPicker.tsx (this
 * component only handles the search-and-pick interaction; the caller,
 * DemoPanel, decides what to do with the picked item, matching how
 * UserPicker's own onSelect just populates the grant-access form
 * rather than submitting anything itself).
 *
 * Requested directly — "unfinished business" the UI copy itself
 * flagged as a known gap (demos.addItemHint used to read "Add by
 * connection/bookmark ID for now — a name-search picker is a natural
 * next step here"). The backend search itself is already scoped to
 * items this person has at least view access to (see
 * routes/demos.ts's own searchDemoItems), so every result shown here
 * is already something they're actually allowed to add — no separate
 * client-side filtering needed.
 */
export function DemoItemPicker({ apiBase, authToken, onSelect, placeholder }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DemoItemOption[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const res = await fetch(`${apiBase}/api/demos/searchable-items?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (res.ok) setResults(await res.json());
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, apiBase, authToken]);

  function pick(item: DemoItemOption) {
    onSelect(item);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="demo-item-picker">
      <input
        placeholder={placeholder ?? t('demos.itemPickerPlaceholder')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} // allow the click on a result to register first
      />
      {open && results.length > 0 && (
        <ul className="demo-item-picker-results">
          {results.map((item) => (
            <li key={item.id}>
              <button onMouseDown={() => pick(item)}>
                {item.name}
                <span className="protocol-tag">{item.item_type === 'connection' ? item.protocol : t('demos.linkTag')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
