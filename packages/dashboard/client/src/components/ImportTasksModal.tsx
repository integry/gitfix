import React, { useState } from 'react';
import axios from 'axios';
import config from '../config';

interface ImportTasksModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ImportTasksModal: React.FC<ImportTasksModalProps> = ({ isOpen, onClose }) => {
  const [taskDescription, setTaskDescription] = useState('');
  const [repository, setRepository] = useState('integry/gitfix');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = async () => {
    if (!taskDescription.trim()) {
      setError('Task description cannot be empty.');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await axios.post(
        `${config.API_BASE_URL}/api/import-tasks`,
        {
          taskDescription,
          repository,
        },
        { withCredentials: true }
      );
      alert(`Task import job started: ${response.data.jobId}`);
      setTaskDescription('');
      onClose();
    } catch (err) {
      console.error('Failed to submit task import job', err);
      setError('Failed to start import job. Please check console for details.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl text-white">
        <div className="flex justify-between items-center p-4 border-b border-gray-700">
          <h3 className="text-xl font-bold">Import Tasks</h3>
          <button 
            onClick={onClose} 
            className="text-gray-400 hover:text-white text-2xl leading-none"
          >
            &times;
          </button>
        </div>
        <div className="p-4">
          <p className="text-sm text-gray-400 mb-4">
            Paste your task description, plan, or abstract request below. The AI analyst will
            process this text, analyze the '{repository}' repository, and generate detailed
            GitHub issues.
          </p>
          
          <div className="mb-4">
            <label htmlFor="repository" className="block text-sm font-medium text-gray-300 mb-2">
              Repository
            </label>
            <select
              id="repository"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              className="w-full p-2 bg-gray-900 border border-gray-700 rounded text-white"
              disabled={isLoading}
            >
              <option value="integry/gitfix">integry/gitfix</option>
            </select>
          </div>

          <textarea
            value={taskDescription}
            onChange={(e) => setTaskDescription(e.target.value)}
            className="w-full h-64 p-3 bg-gray-900 border border-gray-700 rounded text-white resize-none"
            placeholder="Paste your task details here..."
            disabled={isLoading}
            rows={20}
          />
          {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
        </div>
        <div className="flex justify-end p-4 border-t border-gray-700 space-x-2">
          <button
            onClick={onClose}
            className="bg-gray-600 hover:bg-gray-500 text-white px-4 py-2 rounded-lg transition-colors"
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            disabled={isLoading}
          >
            {isLoading ? 'Submitting...' : 'Start Import Job'}
          </button>
        </div>
      </div>
    </div>
  );
};