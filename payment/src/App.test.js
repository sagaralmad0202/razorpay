import { render, screen } from '@testing-library/react';
import App from './App';

test('renders payment form', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /complete payment/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /pay/i })).toBeInTheDocument();
});
