import React from 'react'
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import RepositoriesPage from './pages/RepositoriesPage'
import TasksPage from './pages/TasksPage'
import AiToolsPage from './pages/AiToolsPage'
import SettingsPage from './pages/SettingsPage'
import './App.css'

function App() {
  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={
            <Layout>
              <Dashboard />
            </Layout>
          }
        />
        <Route
          path="/repositories"
          element={
            <Layout>
              <RepositoriesPage />
            </Layout>
          }
        />
        <Route
          path="/tasks"
          element={
            <Layout>
              <TasksPage />
            </Layout>
          }
        />
        <Route
          path="/tasks/:taskId"
          element={
            <Layout>
              <TasksPage />
            </Layout>
          }
        />
        <Route
          path="/ai-tools"
          element={
            <Layout>
              <AiToolsPage />
            </Layout>
          }
        />
        <Route
          path="/settings"
          element={
            <Layout>
              <SettingsPage />
            </Layout>
          }
        />
      </Routes>
    </Router>
  )
}

export default App
