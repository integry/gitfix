import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import SettingsNavigation, {
  matchesSettingsSearch,
  type SettingsNavigationSection
} from './SettingsNavigation';

const sections: SettingsNavigationSection[] = [
  {
    id: 'model-selection',
    category: 'models',
    searchText: 'implementation model reasoning',
    content: <p>Model controls</p>
  },
  {
    id: 'merge-rules',
    category: 'automation',
    searchText: 'automatically resolve merge conflicts',
    content: <p>Merge controls</p>
  },
  {
    id: 'visual-previews',
    category: 'integrations',
    searchText: 'GitHub screenshot upload token',
    content: <p>Preview controls</p>
  },
  {
    id: 'personal-notifications',
    category: 'notifications',
    searchText: 'browser push inbox quiet hours timezone',
    content: <p>Notification controls</p>
  }
];

describe('SettingsNavigation', () => {
  test('organizes settings into category tabs', () => {
    const { container } = render(<SettingsNavigation sections={sections} />);

    const modelsTab = screen.getByRole('tab', { name: /AI & Models/ });
    expect(modelsTab).toHaveAttribute('aria-selected', 'true');
    expect(modelsTab).toHaveClass('border-teal-600', 'text-teal-700');
    expect(modelsTab).not.toHaveClass('bg-gray-900', 'rounded-md');
    expect(modelsTab.querySelector('span')).toHaveClass('bg-slate-100', 'text-slate-500');
    const navigationRow = screen.getByRole('tablist', { name: 'Settings categories' }).parentElement?.parentElement;
    expect(navigationRow).toHaveClass(
      'w-full',
      'flex-col',
      'items-stretch',
      'border-b',
      'border-slate-200',
      'sm:flex-row',
      'sm:items-end'
    );
    expect(navigationRow).toContainElement(screen.getByRole('searchbox', { name: 'Search settings' }));
    expect(screen.getByRole('searchbox', { name: 'Search settings' }).parentElement).toHaveClass(
      'order-first',
      'w-full',
      'flex-shrink-0',
      'sm:order-none',
      'sm:ml-auto',
      'sm:w-64'
    );
    expect(container.querySelector('[data-settings-section="model-selection"]')).toHaveClass(
      '[&_select]:max-w-md',
      '[&_select]:border',
      '[&_select]:border-slate-300',
      '[&_select]:bg-white',
      '[&_select]:shadow-sm'
    );
    expect(container.querySelector('[data-settings-section="model-selection"]')).not.toHaveClass('rounded-lg', 'border', 'shadow-sm');
    expect(screen.getByText('Model controls')).toBeVisible();
    expect(screen.getByText('Merge controls')).not.toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: /Automation/ }));

    expect(screen.getByRole('tab', { name: /Automation/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Merge controls')).toBeVisible();
    expect(screen.getByText('Model controls')).not.toBeVisible();
  });

  test('searches every category and restores the selected tab when cleared', () => {
    render(<SettingsNavigation sections={sections} />);
    fireEvent.click(screen.getByRole('tab', { name: /Automation/ }));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'quiet hours' }
    });

    expect(screen.getByText('Notification controls')).toBeVisible();
    expect(screen.getByText('Merge controls')).not.toBeVisible();
    expect(screen.getByText(/1 section matching “quiet hours”/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Clear settings search' }));

    expect(screen.getByText('Merge controls')).toBeVisible();
    expect(screen.getByText('Notification controls')).not.toBeVisible();
  });

  test('shows an actionable empty state for unmatched keywords', () => {
    render(<SettingsNavigation sections={sections} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'does-not-exist' }
    });

    expect(screen.getByText('No settings found')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Model controls')).toBeVisible();
  });

  test('matches every word case-insensitively', () => {
    expect(matchesSettingsSearch(sections[1], 'MERGE conflicts')).toBe(true);
    expect(matchesSettingsSearch(sections[1], 'merge notifications')).toBe(false);
  });

  test('keeps navigation enabled while disabling settings in read-only mode', () => {
    render(
      <SettingsNavigation
        sections={[{
          id: 'model-selection',
          category: 'models',
          searchText: 'model',
          content: <input aria-label="Model setting" />
        }]}
        isReadOnly
      />
    );

    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: /Automation/ })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Model setting' })).toBeDisabled();
  });
});
