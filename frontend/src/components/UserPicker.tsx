import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface UserOption {
  id: string;
  username: string;
}

interface Props {
  apiBase: string;
  authToken: string;
  onSelect: (user: UserOption) => void;
  placeholder?: string;
}

/**
 * Typeahead over GET /api/users/search. Selecting an option calls onSelect
 * and clears the input — the caller decides what to do with the picked user
 * (grant a list permission, grant demo access, etc.), this component only
 * handles the search-and-pick interaction.
 */
export function UserPicker({ apiBase, authToken, onSelect, placeholder }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserOption[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const res = await fetch(`${apiBase}/api/users/search?q=${encodeURIComponent(query)}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (res.ok) setResults(await res.json());
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, apiBase, authToken]);

  function pick(user: UserOption) {
    onSelect(user);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="user-picker">
      <input
        placeholder={placeholder ?? t('userPicker.defaultPlaceholder')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} // allow the click on a result to register first
      />
      {open && results.length > 0 && (
        <ul className="user-picker-results">
          {results.map((u) => (
            <li key={u.id}>
              <button onMouseDown={() => pick(u)}>{u.username}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
