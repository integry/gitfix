import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';

export type SettingsCategoryId = 'models' | 'automation' | 'integrations' | 'notifications';

interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: 'models',
    label: 'AI & Models',
    description: 'Choose models and configure the repository knowledge base.'
  },
  {
    id: 'automation',
    label: 'Automation',
    description: 'Control processing rules, labels, follow-ups, and worker behavior.'
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Connect supporting services and customize agent runtimes.'
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Choose which updates reach your inbox and browser.'
  }
];

export interface SettingsNavigationSection {
  id: string;
  category: SettingsCategoryId;
  searchText: string;
  content: React.ReactNode;
}

interface SettingsNavigationProps {
  sections: SettingsNavigationSection[];
  isReadOnly?: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components
export function matchesSettingsSearch(section: SettingsNavigationSection, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const searchableText = `${section.id} ${section.searchText}`.toLocaleLowerCase();
  return terms.every(term => searchableText.includes(term));
}

const SettingsNavigation: React.FC<SettingsNavigationProps> = ({ sections, isReadOnly = false }) => {
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('models');
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim();

  const matchedSectionIds = useMemo(
    () => new Set(sections.filter(section => matchesSettingsSearch(section, normalizedQuery)).map(section => section.id)),
    [normalizedQuery, sections]
  );

  const searchResultCount = normalizedQuery ? matchedSectionIds.size : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-shrink-0 bg-white">
        <div className="flex w-full items-end gap-3 border-b border-slate-200 px-4 sm:gap-6 sm:px-6">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex min-w-max gap-6" role="tablist" aria-label="Settings categories">
              {SETTINGS_CATEGORIES.map(category => {
                const sectionCount = sections.filter(section => section.category === category.id).length;
                const selected = activeCategory === category.id;
                return (
                  <button
                    key={category.id}
                    id={`settings-tab-${category.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`settings-panel-${category.id}`}
                    onClick={() => {
                      setActiveCategory(category.id);
                      setQuery('');
                    }}
                    className={`inline-flex items-center border-b-2 pb-2 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 ${
                      selected
                        ? 'border-teal-600 font-semibold text-teal-700'
                        : 'border-transparent font-medium text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    {category.label}
                    <span className="ml-2 rounded bg-slate-100 px-1.5 text-[10px] text-slate-500">
                      {sectionCount}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative mb-2 ml-auto w-32 flex-shrink-0 sm:w-64">
            <label htmlFor="settings-search" className="sr-only">Search settings</label>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            />
            <input
              id="settings-search"
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search settings..."
              className="h-9 w-full rounded-md border border-gray-300 bg-gray-50 pl-9 pr-9 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear settings search"
                className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <p className="sr-only" aria-live="polite">
          {normalizedQuery
            ? `${searchResultCount} settings ${searchResultCount === 1 ? 'section' : 'sections'} found.`
            : `${SETTINGS_CATEGORIES.find(category => category.id === activeCategory)?.label} settings selected.`}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-5 sm:px-6">
        <div className="max-w-5xl">
          {normalizedQuery && (
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">Search results</h3>
                <p className="mt-0.5 text-xs text-gray-500">
                  {searchResultCount} {searchResultCount === 1 ? 'section' : 'sections'} matching “{normalizedQuery}”
                </p>
              </div>
            </div>
          )}

          {SETTINGS_CATEGORIES.map(category => {
            const categorySections = sections.filter(section => section.category === category.id);
            const visibleSections = normalizedQuery
              ? categorySections.filter(section => matchedSectionIds.has(section.id))
              : categorySections;
            const categoryIsVisible = normalizedQuery
              ? visibleSections.length > 0
              : activeCategory === category.id;

            return (
              <section
                key={category.id}
                id={`settings-panel-${category.id}`}
                role={normalizedQuery ? 'region' : 'tabpanel'}
                aria-labelledby={`settings-tab-${category.id}`}
                hidden={!categoryIsVisible}
              >
                <div className={normalizedQuery ? 'mb-3 mt-6 first:mt-0' : 'mb-4'}>
                  <h3 className="text-sm font-semibold text-gray-900">{category.label}</h3>
                  <p className="mt-0.5 text-xs text-gray-500">{category.description}</p>
                </div>

                <div className="space-y-8">
                  {categorySections.map(section => (
                    <div
                      key={section.id}
                      hidden={normalizedQuery ? !matchedSectionIds.has(section.id) : false}
                      data-settings-section={section.id}
                      className="[&_input]:max-w-md [&_select]:max-w-md [&_select]:border [&_select]:border-slate-300 [&_select]:bg-white [&_select]:shadow-sm [&_textarea]:max-w-md"
                    >
                      <fieldset disabled={isReadOnly} className={isReadOnly ? 'opacity-70' : ''}>
                        {section.content}
                      </fieldset>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          {normalizedQuery && searchResultCount === 0 && (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
              <Search aria-hidden="true" className="mx-auto h-6 w-6 text-gray-300" />
              <h3 className="mt-3 text-sm font-medium text-gray-900">No settings found</h3>
              <p className="mt-1 text-xs text-gray-500">Try a different keyword or clear the search.</p>
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-4 rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Clear search
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsNavigation;
