const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const cron = require('node-cron');
const fs = require('fs');

const app = express();
const PORT = 3000;

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT,
    name TEXT,
    avatar TEXT DEFAULT 'default.png'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    student_id INTEGER,
    date_time TEXT,
    status TEXT DEFAULT 'planned',
    price INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS homeworks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    student_id INTEGER,
    title TEXT,
    description TEXT,
    deadline TEXT,
    status TEXT DEFAULT 'assigned',
    file TEXT,
    grade TEXT,
    feedback TEXT,
    student_done INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    student_id INTEGER,
    amount INTEGER,
    date TEXT,
    type TEXT DEFAULT 'income',
    description TEXT DEFAULT ''
  )`);
});

const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'tutor-secret-key-2024',
  resave: false,
  saveUninitialized: false
}));

function checkAuth(req, res, next) {
  if (req.session.user) { next(); }
  else { res.redirect('/login'); }
}

app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'teacher') res.redirect('/teacher/dashboard');
    else res.redirect('/student/dashboard');
  } else {
    res.redirect('/login');
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.user = user;
      if (user.role === 'teacher') res.redirect('/teacher/dashboard');
      else res.redirect('/student/dashboard');
    } else {
      res.render('login', { error: 'Неверный логин или пароль' });
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/teacher/dashboard', checkAuth, (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/');
  db.all('SELECT * FROM lessons WHERE teacher_id = ? AND date(date_time) = date("now") ORDER BY date_time', [req.session.user.id], (err, todayLessons) => {
    db.all('SELECT SUM(amount) as total FROM payments WHERE teacher_id = ? AND type = "income" AND strftime("%Y-%m", date) = strftime("%Y-%m", "now")', [req.session.user.id], (err, moneyData) => {
      db.all('SELECT * FROM homeworks WHERE teacher_id = ? AND status = "submitted"', [req.session.user.id], (err, pendingHomeworks) => {
        res.render('teacher/dashboard', {
          user: req.session.user,
          todayLessons: todayLessons || [],
          totalMoney: moneyData[0]?.total || 0,
          pendingCount: pendingHomeworks?.length || 0
        });
      });
    });
  });
});

app.get('/teacher/calendar', checkAuth, (req, res) => {
  db.all('SELECT lessons.*, users.name as student_name FROM lessons JOIN users ON lessons.student_id = users.id WHERE lessons.teacher_id = ? ORDER BY date_time', [req.session.user.id], (err, lessons) => {
    db.all('SELECT id, name FROM users WHERE role = "student"', (err, students) => {
      res.render('teacher/calendar', { user: req.session.user, lessons, students });
    });
  });
});

app.post('/teacher/add-lesson', checkAuth, upload.none(), (req, res) => {
  const { student_id, date_time, price } = req.body;
  db.run('INSERT INTO lessons (teacher_id, student_id, date_time, price) VALUES (?, ?, ?, ?)', [req.session.user.id, student_id, date_time, price], () => {
    res.redirect('/teacher/calendar');
  });
});

app.get('/teacher/lesson-status/:id/:status', checkAuth, (req, res) => {
  db.run('UPDATE lessons SET status = ? WHERE id = ? AND teacher_id = ?', [req.params.status, req.params.id, req.session.user.id], () => {
    res.redirect('/teacher/calendar');
  });
});

app.get('/teacher/students', checkAuth, (req, res) => {
  db.all('SELECT * FROM users WHERE role = "student"', (err, students) => {
    res.render('teacher/students', { user: req.session.user, students });
  });
});

app.get('/teacher/student/:id', checkAuth, (req, res) => {
  db.get('SELECT * FROM users WHERE id = ?', [req.params.id], (err, student) => {
    if (!student) return res.redirect('/teacher/students');
    db.all('SELECT * FROM lessons WHERE student_id = ? AND teacher_id = ? ORDER BY date_time DESC LIMIT 20', [req.params.id, req.session.user.id], (err, lessons) => {
      db.all('SELECT * FROM homeworks WHERE student_id = ? AND teacher_id = ? ORDER BY deadline DESC', [req.params.id, req.session.user.id], (err, homeworks) => {
        db.all('SELECT * FROM payments WHERE student_id = ? AND teacher_id = ? ORDER BY date DESC', [req.params.id, req.session.user.id], (err, payments) => {
          res.render('teacher/student-detail', { user: req.session.user, student, lessons, homeworks, payments });
        });
      });
    });
  });
});

app.post('/teacher/add-homework', checkAuth, upload.single('file'), (req, res) => {
  const { student_id, title, description, deadline } = req.body;
  const file = req.file ? req.file.filename : null;
  db.run('INSERT INTO homeworks (teacher_id, student_id, title, description, deadline, file) VALUES (?, ?, ?, ?, ?, ?)', [req.session.user.id, student_id, title, description, deadline, file], () => {
    res.redirect('/teacher/student/' + student_id);
  });
});

app.post('/teacher/add-payment', checkAuth, upload.none(), (req, res) => {
  const { student_id, amount, date } = req.body;
  db.run('INSERT INTO payments (teacher_id, student_id, amount, date, type) VALUES (?, ?, ?, ?, "income")', [req.session.user.id, student_id, amount, date], () => {
    res.redirect('/teacher/student/' + student_id);
  });
});

app.get('/teacher/check-homeworks', checkAuth, (req, res) => {
  db.all('SELECT homeworks.*, users.name as student_name FROM homeworks JOIN users ON homeworks.student_id = users.id WHERE homeworks.teacher_id = ? AND homeworks.status = "submitted"', [req.session.user.id], (err, homeworks) => {
    res.render('teacher/check', { user: req.session.user, homeworks });
  });
});

app.get('/teacher/review-homework/:id', checkAuth, (req, res) => {
  db.get('SELECT homeworks.*, users.name as student_name FROM homeworks JOIN users ON homeworks.student_id = users.id WHERE homeworks.id = ?', [req.params.id], (err, homework) => {
    res.render('teacher/review', { user: req.session.user, homework });
  });
});

app.post('/teacher/submit-review', checkAuth, upload.none(), (req, res) => {
  const { homework_id, grade, feedback } = req.body;
  db.run('UPDATE homeworks SET status = "checked", grade = ?, feedback = ? WHERE id = ?', [grade, feedback, homework_id], () => {
    res.redirect('/teacher/check-homeworks');
  });
});

app.get('/teacher/finances', checkAuth, (req, res) => {
  db.all('SELECT SUM(amount) as total FROM payments WHERE teacher_id = ? AND type = "income"', [req.session.user.id], (err, incomeData) => {
    db.all('SELECT SUM(amount) as total FROM payments WHERE teacher_id = ? AND type = "expense"', [req.session.user.id], (err, expenseData) => {
      db.all('SELECT * FROM payments WHERE teacher_id = ? ORDER BY date DESC LIMIT 100', [req.session.user.id], (err, finances) => {
        res.render('teacher/finances', {
          user: req.session.user,
          totalIncome: incomeData[0]?.total || 0,
          totalExpense: expenseData[0]?.total || 0,
          finances: finances || []
        });
      });
    });
  });
});

app.post('/teacher/add-finance', checkAuth, upload.none(), (req, res) => {
  const { type, amount, description, date } = req.body;
  db.run('INSERT INTO payments (teacher_id, student_id, amount, date, type, description) VALUES (?, ?, ?, ?, ?, ?)', [req.session.user.id, null, amount, date, type, description || ''], () => {
    res.redirect('/teacher/finances');
  });
});

app.get('/teacher/create-student', checkAuth, (req, res) => {
  res.render('teacher/create-student', { user: req.session.user, generatedLogin: null, generatedPassword: null, error: null });
});

app.post('/teacher/create-student', checkAuth, upload.none(), (req, res) => {
  const { name, email } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, existing) => {
    if (existing) {
      return res.render('teacher/create-student', { user: req.session.user, generatedLogin: null, generatedPassword: null, error: 'Этот email уже занят' });
    }
    const password = Math.random().toString(36).slice(-6);
    const hash = bcrypt.hashSync(password, 10);
    db.run('INSERT INTO users (email, password, role, name) VALUES (?, ?, ?, ?)', [email, hash, 'student', name], () => {
      res.render('teacher/create-student', { user: req.session.user, generatedLogin: email, generatedPassword: password, error: null });
    });
  });
});

app.get('/student/dashboard', checkAuth, (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/');
  db.all('SELECT * FROM homeworks WHERE student_id = ? ORDER BY deadline DESC', [req.session.user.id], (err, homeworks) => {
    res.render('student/dashboard', { user: req.session.user, homeworks: homeworks || [] });
  });
});

app.post('/student/toggle-done', checkAuth, upload.none(), (req, res) => {
  const { homework_id, done } = req.body;
  db.run('UPDATE homeworks SET student_done = ? WHERE id = ? AND student_id = ?', [done, homework_id, req.session.user.id], () => {
    res.redirect('/student/dashboard');
  });
});

app.post('/student/submit-homework', checkAuth, upload.single('file'), (req, res) => {
  const { homework_id } = req.body;
  const file = req.file ? req.file.filename : null;
  if (file) {
    db.run('UPDATE homeworks SET file = ?, status = "submitted" WHERE id = ? AND student_id = ?', [file, homework_id, req.session.user.id], () => {
      res.redirect('/student/dashboard');
    });
  } else {
    db.run('UPDATE homeworks SET status = "submitted" WHERE id = ? AND student_id = ?', [homework_id, req.session.user.id], () => {
      res.redirect('/student/dashboard');
    });
  }
});

app.post('/student/ask-question', checkAuth, upload.none(), (req, res) => {
  const { homework_id, question } = req.body;
  db.run('UPDATE homeworks SET feedback = ? WHERE id = ? AND student_id = ?', ['Вопрос ученика: ' + question, homework_id, req.session.user.id], () => {
    res.redirect('/student/dashboard');
  });
});

app.get('/student/profile', checkAuth, (req, res) => {
  res.render('student/profile', { user: req.session.user, success: null });
});

app.post('/student/update-avatar', checkAuth, upload.single('avatar'), (req, res) => {
  const avatar = req.file ? req.file.filename : 'default.png';
  db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.session.user.id], () => {
    req.session.user.avatar = avatar;
    res.render('student/profile', { user: req.session.user, success: 'Аватар обновлён!' });
  });
});

app.listen(PORT, () => {
  console.log('Сайт запущен: http://localhost:' + PORT);
  db.get("SELECT * FROM users WHERE role = 'teacher'", (err, teacher) => {
    if (!teacher) {
      const hash = bcrypt.hashSync('12345', 10);
      db.run("INSERT INTO users (email, password, role, name) VALUES (?, ?, ?, ?)", ['teacher@mail.com', hash, 'teacher', 'Репетитор']);
      console.log('Создан учитель: teacher@mail.com / 12345');
    }
  });
  db.get("SELECT * FROM users WHERE role = 'student'", (err, student) => {
    if (!student) {
      const hash = bcrypt.hashSync('12345', 10);
      db.run("INSERT INTO users (email, password, role, name) VALUES (?, ?, ?, ?)", ['student@mail.com', hash, 'student', 'Ученик Петя']);
      console.log('Создан ученик: student@mail.com / 12345');
    }
  });
  console.log('Система напоминаний запущена');
});
