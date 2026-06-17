const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const app = express();
const PORT = 3000;
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, role TEXT, name TEXT, phone TEXT DEFAULT '', parent_phone TEXT DEFAULT '', notes TEXT DEFAULT '', subject TEXT DEFAULT '', level TEXT DEFAULT '', goals TEXT DEFAULT '', status TEXT DEFAULT 'active', avatar TEXT DEFAULT 'default.png')`);
  db.run(`CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, student_id INTEGER, date_time TEXT, status TEXT DEFAULT 'planned', price INTEGER, topic TEXT DEFAULT '', duration INTEGER DEFAULT 60, link TEXT DEFAULT '', materials TEXT DEFAULT '', grade INTEGER DEFAULT 0, teacher_comment TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS homeworks (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, student_id INTEGER, title TEXT, description TEXT, deadline TEXT, status TEXT DEFAULT 'assigned', file TEXT, grade TEXT, feedback TEXT, student_done INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, student_id INTEGER, amount INTEGER, date TEXT, type TEXT DEFAULT 'income', description TEXT DEFAULT '')`);
  db.run(`CREATE TABLE IF NOT EXISTS receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, student_id INTEGER, created_at TEXT, month TEXT, total INTEGER, status TEXT DEFAULT 'active')`);
  db.run(`CREATE TABLE IF NOT EXISTS library (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER, student_id INTEGER, title TEXT, url TEXT, description TEXT, created_at TEXT DEFAULT (date('now')))`);
});

const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname) });
const upload = multer({ storage });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'tutor-secret', resave: false, saveUninitialized: false }));

function checkAuth(req, res, next) { if (req.session.user) next(); else res.redirect('/login'); }

app.get('/', (req, res) => {
  if (req.session.user) { if (req.session.user.role === 'teacher') res.redirect('/teacher/dashboard'); else res.redirect('/student/dashboard'); }
  else res.redirect('/login');
});

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.user = user;
      if (user.role === 'teacher') res.redirect('/teacher/dashboard'); else res.redirect('/student/dashboard');
    } else res.render('login', { error: 'Неверный логин или пароль' });
  });
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ========== УЧИТЕЛЬ ==========

app.get('/teacher/dashboard', checkAuth, (req, res) => {
  db.all("SELECT lessons.*, users.name as student_name FROM lessons JOIN users ON lessons.student_id=users.id WHERE lessons.teacher_id=? AND date(lessons.date_time)=date('now') ORDER BY lessons.date_time", [req.session.user.id], (err, today) => {
    db.all("SELECT SUM(amount) as total FROM payments WHERE teacher_id=? AND type='income' AND strftime('%Y-%m',date)=strftime('%Y-%m','now')", [req.session.user.id], (err, inc) => {
      db.all("SELECT SUM(amount) as total FROM payments WHERE teacher_id=? AND type='expense' AND strftime('%Y-%m',date)=strftime('%Y-%m','now')", [req.session.user.id], (err, exp) => {
        db.all("SELECT * FROM homeworks WHERE teacher_id=? AND status='submitted'", [req.session.user.id], (err, pending) => {
          res.render('teacher/dashboard', { user: req.session.user, todayLessons: today||[], totalIncome: inc[0]?.total||0, totalExpense: exp[0]?.total||0, pendingCount: pending?.length||0 });
        });
      });
    });
  });
});

app.get('/teacher/students', checkAuth, (req, res) => {
  db.all("SELECT * FROM users WHERE role='student' ORDER BY name", (err, students) => res.render('teacher/students', { user: req.session.user, students }));
});

app.get('/teacher/student/:id', checkAuth, (req, res) => {
  db.get('SELECT * FROM users WHERE id=?', [req.params.id], (err, student) => {
    if (!student) return res.redirect('/teacher/students');
    db.all('SELECT * FROM lessons WHERE student_id=? AND teacher_id=? ORDER BY date_time DESC LIMIT 50', [req.params.id, req.session.user.id], (err, lessons) => {
      db.all('SELECT * FROM homeworks WHERE student_id=? AND teacher_id=? ORDER BY deadline DESC', [req.params.id, req.session.user.id], (err, homeworks) => {
        db.all('SELECT * FROM payments WHERE student_id=? AND teacher_id=? ORDER BY date DESC', [req.params.id, req.session.user.id], (err, payments) => {
          res.render('teacher/student-detail', { user: req.session.user, student, lessons, homeworks, payments });
        });
      });
    });
  });
});

app.post('/teacher/update-student/:id', checkAuth, upload.none(), (req, res) => {
  const { name, email, phone, parent_phone, notes, subject, level, goals, status } = req.body;
  db.run('UPDATE users SET name=?,email=?,phone=?,parent_phone=?,notes=?,subject=?,level=?,goals=?,status=? WHERE id=?', [name, email, phone||'', parent_phone||'', notes||'', subject||'', level||'', goals||'', status||'active', req.params.id], () => res.redirect('/teacher/student/'+req.params.id));
});

app.get('/teacher/delete-student/:id', checkAuth, (req, res) => {
  db.run('DELETE FROM homeworks WHERE student_id=?', [req.params.id]);
  db.run('DELETE FROM lessons WHERE student_id=?', [req.params.id]);
  db.run('DELETE FROM payments WHERE student_id=?', [req.params.id]);
  db.run("DELETE FROM users WHERE id=? AND role='student'", [req.params.id], () => res.redirect('/teacher/students'));
});

app.get('/teacher/create-student', checkAuth, (req, res) => res.render('teacher/create-student', { user: req.session.user, generatedLogin: null, generatedPassword: null, error: null }));

app.post('/teacher/create-student', checkAuth, upload.none(), (req, res) => {
  const { name, email, phone, parent_phone, notes, subject, level, goals } = req.body;
  db.get('SELECT * FROM users WHERE email=?', [email], (err, exists) => {
    if (exists) return res.render('teacher/create-student', { user: req.session.user, generatedLogin: null, generatedPassword: null, error: 'Email занят' });
    const pass = Math.random().toString(36).slice(-6);
    const hash = bcrypt.hashSync(pass, 10);
db.run("INSERT INTO users (email,password,role,name,phone,parent_phone,notes,subject,level,goals,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [email, hash, 'student', name, phone||'', parent_phone||'', notes||'', subject||'', level||'', goals||'', 'active'], function(err) {
       if (err) { console.log('ОШИБКА:', err.message); return res.render('teacher/create-student', { user: req.session.user, generatedLogin: null, generatedPassword: null, error: err.message }); }
      res.render('teacher/create-student', { user: req.session.user, generatedLogin: email, generatedPassword: pass, error: null });
    });
  });
});

app.get('/teacher/calendar', checkAuth, (req, res) => {
  db.all('SELECT lessons.*, users.name as student_name FROM lessons JOIN users ON lessons.student_id=users.id WHERE lessons.teacher_id=? ORDER BY lessons.date_time', [req.session.user.id], (err, lessons) => {
    db.all("SELECT id, name FROM users WHERE role='student'", (err, students) => res.render('teacher/calendar', { user: req.session.user, lessons, students }));
  });
});

app.post('/teacher/add-lesson', checkAuth, upload.none(), (req, res) => {
  const { student_id, date_time, price, topic, duration, link } = req.body;
  db.run('INSERT INTO lessons (teacher_id,student_id,date_time,price,topic,duration,link) VALUES (?,?,?,?,?,?,?)', [req.session.user.id, student_id, date_time, price, topic||'', duration||60, link||''], () => res.redirect('/teacher/calendar'));
});

app.post('/teacher/edit-lesson', checkAuth, upload.none(), (req, res) => {
  const { id, date_time, price, status, topic, duration, link, grade, teacher_comment, materials } = req.body;
  db.run('UPDATE lessons SET date_time=?,price=?,status=?,topic=?,duration=?,link=?,grade=?,teacher_comment=?,materials=? WHERE id=? AND teacher_id=?', [date_time, price, status, topic||'', duration||60, link||'', grade||0, teacher_comment||'', materials||'', id, req.session.user.id], () => res.redirect('/teacher/calendar'));
});

app.get('/teacher/delete-lesson/:id', checkAuth, (req, res) => {
  db.run('DELETE FROM lessons WHERE id=? AND teacher_id=?', [req.params.id, req.session.user.id], () => res.redirect('/teacher/calendar'));
});

app.post('/teacher/add-homework', checkAuth, upload.single('file'), (req, res) => {
  const { student_id, title, description, deadline } = req.body;
  const file = req.file ? req.file.filename : null;
  db.run('INSERT INTO homeworks (teacher_id,student_id,title,description,deadline,file) VALUES (?,?,?,?,?,?)', [req.session.user.id, student_id, title, description, deadline, file], () => res.redirect('/teacher/student/'+student_id));
});

app.get('/teacher/check-homeworks', checkAuth, (req, res) => {
  db.all("SELECT homeworks.*, users.name as student_name FROM homeworks JOIN users ON homeworks.student_id=users.id WHERE homeworks.teacher_id=? AND homeworks.status='submitted'", [req.session.user.id], (err, homeworks) => res.render('teacher/check', { user: req.session.user, homeworks }));
});

app.get('/teacher/review-homework/:id', checkAuth, (req, res) => {
  db.get('SELECT homeworks.*, users.name as student_name FROM homeworks JOIN users ON homeworks.student_id=users.id WHERE homeworks.id=?', [req.params.id], (err, homework) => res.render('teacher/review', { user: req.session.user, homework }));
});

app.post('/teacher/submit-review', checkAuth, upload.none(), (req, res) => {
  const { homework_id, grade, feedback } = req.body;
  db.run("UPDATE homeworks SET status='checked', grade=?, feedback=? WHERE id=?", [grade, feedback, homework_id], () => res.redirect('/teacher/check-homeworks'));
});

app.get('/teacher/finances', checkAuth, (req, res) => {
  db.all("SELECT SUM(amount) as total FROM payments WHERE teacher_id=? AND type='income'", [req.session.user.id], (err, inc) => {
    db.all("SELECT SUM(amount) as total FROM payments WHERE teacher_id=? AND type='expense'", [req.session.user.id], (err, exp) => {
      db.all('SELECT * FROM payments WHERE teacher_id=? ORDER BY date DESC LIMIT 100', [req.session.user.id], (err, fin) => {
        res.render('teacher/finances', { user: req.session.user, totalIncome: inc[0]?.total||0, totalExpense: exp[0]?.total||0, finances: fin||[] });
      });
    });
  });
});

app.post('/teacher/add-finance', checkAuth, upload.none(), (req, res) => {
  const { type, amount, description, date } = req.body;
  db.run('INSERT INTO payments (teacher_id,student_id,amount,date,type,description) VALUES (?,?,?,?,?,?)', [req.session.user.id, null, amount, date, type, description||''], () => res.redirect('/teacher/finances'));
});

app.get('/teacher/receipts', checkAuth, (req, res) => {
  db.all("SELECT * FROM users WHERE role='student'", (err, students) => {
    db.all("SELECT receipts.*, users.name as student_name FROM receipts JOIN users ON receipts.student_id=users.id WHERE receipts.teacher_id=? ORDER BY receipts.created_at DESC", [req.session.user.id], (err, receipts) => {
      res.render('teacher/receipts', { user: req.session.user, students, receipts: receipts||[] });
    });
  });
});

app.post('/teacher/create-receipt', checkAuth, upload.none(), (req, res) => {
  const { student_id, month } = req.body;
  db.get("SELECT SUM(amount) as total FROM payments WHERE teacher_id=? AND student_id=? AND type='income' AND strftime('%Y-%m',date)=?", [req.session.user.id, student_id, month], (err, data) => {
    db.run('INSERT INTO receipts (teacher_id,student_id,created_at,month,total) VALUES (?,?,?,?,?)', [req.session.user.id, student_id, new Date().toISOString().slice(0,10), month, data?.total||0], () => res.redirect('/teacher/receipts'));
  });
});

app.get('/teacher/library', checkAuth, (req, res) => {
  db.all("SELECT * FROM users WHERE role='student'", (err, students) => {
    db.all("SELECT library.*, users.name as student_name FROM library JOIN users ON library.student_id=users.id WHERE library.teacher_id=? ORDER BY library.created_at DESC", [req.session.user.id], (err, items) => {
      res.render('teacher/library', { user: req.session.user, students, items: items||[] });
    });
  });
});

app.post('/teacher/add-library', checkAuth, upload.none(), (req, res) => {
  const { student_id, title, url, description } = req.body;
  db.run('INSERT INTO library (teacher_id,student_id,title,url,description) VALUES (?,?,?,?,?)', [req.session.user.id, student_id||null, title, url||'', description||''], () => res.redirect('/teacher/library'));
});

// ========== УЧЕНИК ==========

app.get('/student/dashboard', checkAuth, (req, res) => {
  db.get("SELECT * FROM lessons WHERE student_id=? AND date(date_time)>=date('now') ORDER BY date_time LIMIT 1", [req.session.user.id], (err, nextLesson) => {
    db.get("SELECT * FROM homeworks WHERE student_id=? AND status='assigned' ORDER BY deadline LIMIT 1", [req.session.user.id], (err, nextHW) => {
      db.all("SELECT * FROM homeworks WHERE student_id=? AND status='checked' ORDER BY deadline DESC LIMIT 5", [req.session.user.id], (err, lastGrades) => {
        res.render('student/dashboard', { user: req.session.user, nextLesson: nextLesson||null, nextHW: nextHW||null, lastGrades: lastGrades||[] });
      });
    });
  });
});

app.get('/student/calendar', checkAuth, (req, res) => {
  db.all('SELECT * FROM lessons WHERE student_id=? ORDER BY date_time', [req.session.user.id], (err, lessons) => res.render('student/calendar', { user: req.session.user, lessons: lessons||[] }));
});

app.get('/student/lessons', checkAuth, (req, res) => {
  db.all('SELECT * FROM lessons WHERE student_id=? ORDER BY date_time DESC LIMIT 50', [req.session.user.id], (err, lessons) => res.render('student/lessons', { user: req.session.user, lessons: lessons||[] }));
});

app.get('/student/lesson/:id', checkAuth, (req, res) => {
  db.get('SELECT * FROM lessons WHERE id=? AND student_id=?', [req.params.id, req.session.user.id], (err, lesson) => {
    if (!lesson) return res.redirect('/student/lessons');
    res.render('student/lesson-detail', { user: req.session.user, lesson });
  });
});

app.get('/student/homeworks', checkAuth, (req, res) => {
  db.all('SELECT * FROM homeworks WHERE student_id=? ORDER BY deadline DESC', [req.session.user.id], (err, hw) => res.render('student/homeworks', { user: req.session.user, homeworks: hw||[] }));
});

app.post('/student/toggle-done', checkAuth, upload.none(), (req, res) => {
  db.run('UPDATE homeworks SET student_done=? WHERE id=? AND student_id=?', [req.body.done, req.body.homework_id, req.session.user.id], () => res.redirect('/student/homeworks'));
});

app.post('/student/submit-homework', checkAuth, upload.single('file'), (req, res) => {
  const file = req.file ? req.file.filename : null;
  if (file) db.run("UPDATE homeworks SET file=?, status='submitted' WHERE id=? AND student_id=?", [file, req.body.homework_id, req.session.user.id], () => res.redirect('/student/homeworks'));
  else db.run("UPDATE homeworks SET status='submitted' WHERE id=? AND student_id=?", [req.body.homework_id, req.session.user.id], () => res.redirect('/student/homeworks'));
});

app.get('/student/library', checkAuth, (req, res) => {
  db.all('SELECT * FROM library WHERE student_id=? OR student_id IS NULL ORDER BY created_at DESC', [req.session.user.id], (err, items) => res.render('student/library', { user: req.session.user, items: items||[] }));
});

app.get('/student/profile', checkAuth, (req, res) => res.render('student/profile', { user: req.session.user, success: null }));

app.post('/student/update-avatar', checkAuth, upload.single('avatar'), (req, res) => {
  const av = req.file ? req.file.filename : 'default.png';
  db.run('UPDATE users SET avatar=? WHERE id=?', [av, req.session.user.id], () => { req.session.user.avatar = av; res.render('student/profile', { user: req.session.user, success: 'Готово!' }); });
});

app.post('/student/change-password', checkAuth, upload.none(), (req, res) => {
  db.run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(req.body.newpass, 10), req.session.user.id], () => res.render('student/profile', { user: req.session.user, success: 'Пароль изменён!' }));
});

app.listen(PORT, () => {
  console.log('Сайт: http://localhost:' + PORT);
  db.get("SELECT * FROM users WHERE role='teacher'", (err, t) => {
    if (!t) { db.run("INSERT INTO users (email,password,role,name) VALUES (?,?,?,?)", ['teacher@mail.com', bcrypt.hashSync('12345',10), 'teacher', 'Репетитор']); console.log('Учитель: teacher@mail.com / 12345'); }
  });
  db.get("SELECT * FROM users WHERE role='student'", (err, s) => {
    if (!s) { db.run("INSERT INTO users (email,password,role,name,subject,level) VALUES (?,?,?,?,?,?)", ['student@mail.com', bcrypt.hashSync('12345',10), 'student', 'Ученик Петя', 'Математика', '8 класс']); console.log('Ученик: student@mail.com / 12345'); }  // ← ВОТ ЭТА СТРОКА
  });
});