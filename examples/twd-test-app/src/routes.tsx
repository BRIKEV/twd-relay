import { createBrowserRouter } from "react-router";
import App from "./pages/App/App";
import Assertions from "./pages/Assertions/Assertions";
import ScreenQueries from "./pages/ScreenQueries";

const router = createBrowserRouter([
  {
    path: "/",
    Component: App,
  },
  {
    path: "/assertions",
    Component: Assertions,
  },
  {
    path: '/screen-queries',
    Component: ScreenQueries,
  },
  {
    path: "*",
    element: <div>404 Not Found</div>,
  }
]);

export default router;
