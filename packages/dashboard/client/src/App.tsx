import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import RepositoriesPage from './pages/RepositoriesPage';
import TasksPage from './pages/TasksPage';
import AiToolsPage from './pages/AiToolsPage';
import SettingsPage from './pages/SettingsPage';
import Layout from './components/Layout';

function App() {
  return (
    <Router>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout>
                  <Dashboard />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/repositories"
            element={
              <ProtectedRoute>
                <Layout>
                  <RepositoriesPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/tasks"
            element={
              <ProtectedRoute>
                <Layout>
                  <TasksPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/ai-tools"
            element={
              <ProtectedRoute>
                <Layout>
                  <AiToolsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Layout>
                  <SettingsPage />
                </Layout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </AuthProvider>
    </Router>
  );
}

export default App;